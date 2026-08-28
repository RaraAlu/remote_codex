import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";
import type { BridgeConfig, WorkspaceToolRoot } from "../core/types.js";
import type {
  ControllerWorkspaceRequest,
  FuzzyFileSearchMatch,
  RemoteEditorContext,
  RemoteFuzzyFileSearchResult,
} from "../core/vscode-transport.js";
import {
  buildWorkspaceResourceUri,
  parseWorkspaceResourceUri,
  workspaceRelativePath,
  WORKSPACE_RESOURCE_SCHEME,
  type WorkspaceResourceIdentity,
} from "../core/workspace-resource-uri.js";
import { detectRemoteWorkspace } from "./remote-context.js";

const MAX_LIVE_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_COUNT = 16;
const MAX_TOTAL_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_EDITOR_CONTEXT_BYTES = 128 * 1024;
const MAX_FUZZY_FILE_CANDIDATES = 50_000;
const MAX_FUZZY_FILE_RESULTS = 200;
const MAX_FUZZY_QUERY_LENGTH = 1_024;

interface Snapshot {
  content: string;
  resolved: ResolvedResource;
  size: number;
}

interface ResolvedResource {
  actualUri: vscode.Uri;
  identity: WorkspaceResourceIdentity;
  localPath?: string;
  resourceUri: vscode.Uri;
  root: WorkspaceToolRoot;
  threadId?: string;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      `params.${key} must be a non-empty NUL-free string`,
    );
  }
  return value;
}

function optionalPosition(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BridgeError("PROTOCOL_MISMATCH", `params.${key} must be a positive integer`);
  }
  return value;
}

function decodeText(content: Uint8Array, label: string): string {
  if (content.byteLength > MAX_LIVE_RESOURCE_BYTES) {
    throw new BridgeError("OUTPUT_TRUNCATED", `${label} exceeds the 5 MiB editor limit`);
  }
  if (content.includes(0)) {
    throw new BridgeError("COMMAND_DENIED", `${label} is binary`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new BridgeError("COMMAND_DENIED", `${label} is not valid UTF-8 text`, {}, {
      cause: error,
    });
  }
}

function decodeSnapshot(value: string): Uint8Array {
  if (
    value.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new BridgeError("PROTOCOL_MISMATCH", "params.beforeContentBase64 is invalid");
  }
  const content = Buffer.from(value, "base64");
  if (content.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new BridgeError(
      "OUTPUT_TRUNCATED",
      "The Diff before snapshot exceeds the 1 MiB limit",
    );
  }
  return content;
}

function fuzzyMatch(relativePath: string, rawQuery: string): FuzzyFileSearchMatch | null {
  const query = rawQuery.trim().replace(/^@/, "").replaceAll("\\", "/").toLowerCase();
  if (query.length === 0) {
    return null;
  }
  const candidate = relativePath.toLowerCase();
  const indices: number[] = [];
  let cursor = 0;
  for (const character of query) {
    const index = candidate.indexOf(character, cursor);
    if (index < 0) {
      return null;
    }
    indices.push(index);
    cursor = index + 1;
  }

  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const lowerFileName = fileName.toLowerCase();
  const first = indices[0] ?? 0;
  const last = indices.at(-1) ?? first;
  const gaps = last - first + 1 - indices.length;
  let score = 1_000 - Math.min(relativePath.length, 500) - gaps * 5;
  if (candidate === query) {
    score += 4_000;
  } else if (lowerFileName === query) {
    score += 3_000;
  } else if (lowerFileName.startsWith(query)) {
    score += 2_000;
  } else if (candidate.includes(query)) {
    score += 1_000;
  }
  return {
    file_name: fileName,
    indices,
    match_type: "file",
    path: relativePath,
    root: "",
    score,
  };
}

function fuzzySearchGlob(rawQuery: string): string {
  const normalized = rawQuery.trim().replace(/^@/, "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const fuzzySegments = segments.map((segment) => {
    const characters = [...segment].filter((character) => /[\p{L}\p{N}]/u.test(character));
    const pattern = characters
      .map((character) =>
        /^[a-z]$/i.test(character)
          ? `[${character.toLowerCase()}${character.toUpperCase()}]`
          : character,
      )
      .join("*");
    return pattern.length > 0 ? `*${pattern}*` : "*";
  });
  return `**/${fuzzySegments.length > 0 ? fuzzySegments.join("/") : "*"}`;
}

export function isWorkspaceResourceOperation(
  operation: string,
): operation is
  | "resolveEditorContext"
  | "resolveFuzzyFileSearch"
  | "openWorkspaceResource"
  | "registerWorkspaceResource"
  | "showWorkspaceDiff" {
  return (
    operation === "resolveEditorContext" ||
    operation === "resolveFuzzyFileSearch" ||
    operation === "openWorkspaceResource" ||
    operation === "registerWorkspaceResource" ||
    operation === "showWorkspaceDiff"
  );
}

export class WorkspaceResourceController
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  readonly #config: () => BridgeConfig | null;
  readonly #resolveAuthorizedRoot: (
    threadId: string,
    rootId: string,
  ) => WorkspaceToolRoot | undefined;
  readonly #resources = new Map<string, ResolvedResource>();
  readonly #snapshots = new Map<string, Snapshot>();
  #pendingEditorContext: RemoteEditorContext | null = null;
  #snapshotBytes = 0;

  constructor(
    config: () => BridgeConfig | null,
    resolveAuthorizedRoot: (
      threadId: string,
      rootId: string,
    ) => WorkspaceToolRoot | undefined,
  ) {
    this.#config = config;
    this.#resolveAuthorizedRoot = resolveAuthorizedRoot;
  }

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(
      WORKSPACE_RESOURCE_SCHEME,
      this,
    );
  }

  dispose(): void {
    this.#pendingEditorContext = null;
    this.#resources.clear();
    this.#snapshots.clear();
    this.#snapshotBytes = 0;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const identity = parseWorkspaceResourceUri(uri.toString());
    if (identity.revision) {
      const snapshot = this.#snapshots.get(uri.toString());
      if (snapshot) {
        await this.#assertStillAuthorized(snapshot.resolved);
        return snapshot.content;
      }
      throw new BridgeError(
        "COMMAND_DENIED",
        "The requested Diff snapshot has expired",
      );
    }
    const resolved = this.#resources.get(uri.toString());
    if (!resolved) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "The workspace resource was not registered by the active Bridge session",
      );
    }
    await this.#assertStillAuthorized(resolved);
    const metadata = await vscode.workspace.fs.stat(resolved.actualUri);
    if (metadata.size > MAX_LIVE_RESOURCE_BYTES) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Workspace resource exceeds the 5 MiB editor limit",
      );
    }
    return decodeText(
      await vscode.workspace.fs.readFile(resolved.actualUri),
      "Workspace resource",
    );
  }

  async execute(request: ControllerWorkspaceRequest): Promise<unknown> {
    const rootId = requiredString(request.params, "rootId");
    if (request.operation === "resolveEditorContext") {
      return await this.#resolveEditorContext(rootId);
    }
    if (request.operation === "resolveFuzzyFileSearch") {
      return await this.#resolveFuzzyFileSearch(rootId, request.params);
    }
    const path = requiredString(request.params, "path");
    const threadId =
      typeof request.params.threadId === "string"
        ? request.params.threadId
        : undefined;
    const resolved = this.#resolve(rootId, path, undefined, threadId);
    if (request.operation === "registerWorkspaceResource") {
      this.#rememberResource(resolved);
      return this.#result("registered", resolved);
    }
    if (request.operation === "openWorkspaceResource") {
      return await this.#open(resolved, request.params);
    }
    if (request.operation === "showWorkspaceDiff") {
      return await this.#showDiff(resolved, request.params);
    }
    throw new BridgeError(
      "COMMAND_DENIED",
      `Unsupported workspace resource operation: ${request.operation}`,
    );
  }

  async captureEditorContext(
    kind: RemoteEditorContext["kind"],
    resource?: vscode.Uri,
  ): Promise<RemoteEditorContext> {
    const context = await this.#createEditorContext(kind, "explicit", resource);
    this.#pendingEditorContext = context;
    return context;
  }

  async #createEditorContext(
    kind: RemoteEditorContext["kind"],
    origin: RemoteEditorContext["origin"],
    resource?: vscode.Uri,
  ): Promise<RemoteEditorContext> {
    const editor = vscode.window.activeTextEditor;
    if (kind === "selection" && (!editor || editor.selection.isEmpty)) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Select remote editor text before queuing selection context",
      );
    }
    const document =
      kind === "file" && resource
        ? await vscode.workspace.openTextDocument(resource)
        : editor?.document;
    if (!document) {
      throw new BridgeError("COMMAND_DENIED", "No remote editor file is active");
    }
    const resolved = this.#resolveRemoteEditor(document.uri);
    const selection = kind === "selection" ? editor?.selection : undefined;
    const content = selection ? document.getText(selection) : document.getText();
    if (content.includes("\0")) {
      throw new BridgeError("COMMAND_DENIED", "Remote editor context is binary");
    }
    const sizeBytes = new TextEncoder().encode(content).byteLength;
    if (sizeBytes > MAX_EDITOR_CONTEXT_BYTES) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Remote editor context exceeds the 128 KiB limit",
        { limitBytes: MAX_EDITOR_CONTEXT_BYTES, sizeBytes },
      );
    }
    const config = this.#config();
    if (!config) {
      throw new BridgeError("BRIDGE_NOT_READY", "Bridge configuration is unavailable");
    }
    const context: RemoteEditorContext = {
      capturedAtMs: Date.now(),
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      contextId: randomUUID(),
      hostId: config.host,
      kind,
      languageId: document.languageId,
      origin,
      relativePath: resolved.identity.relativePath,
      resourceUri: resolved.resourceUri.toString(),
      rootId: resolved.root.id,
      ...(selection
        ? {
            selection: {
              end: {
                column: selection.end.character + 1,
                line: selection.end.line + 1,
              },
              start: {
                column: selection.start.character + 1,
                line: selection.start.line + 1,
              },
            },
          }
        : {}),
      sizeBytes,
      target: "remote",
      workspaceRoot: config.workspaceRoot,
      workspaceUri: document.uri.toString(),
    };
    return context;
  }

  async #resolveEditorContext(rootId: string): Promise<RemoteEditorContext | null> {
    const context = this.#pendingEditorContext;
    if (context) {
      this.#pendingEditorContext = null;
    }
    const config = this.#config();
    const root = config?.roots.find((candidate) => candidate.id === rootId);
    if (
      !config ||
      config.connectionMode !== "vscode-remote" ||
      !root ||
      root.target !== "remote" ||
      root.role !== "primary" ||
      root.path !== config.workspaceRoot ||
      (context &&
        (context.hostId !== config.host ||
          context.rootId !== root.id ||
          context.workspaceRoot !== config.workspaceRoot))
    ) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Remote editor context does not match the active workspace",
      );
    }
    if (context) {
      return context;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    try {
      return await this.#createEditorContext(
        editor.selection.isEmpty ? "file" : "selection",
        "automatic",
      );
    } catch (error) {
      if (
        error instanceof BridgeError &&
        (error.code === "COMMAND_DENIED" || error.code === "OUTPUT_TRUNCATED")
      ) {
        return null;
      }
      throw error;
    }
  }

  async #resolveFuzzyFileSearch(
    rootId: string,
    params: Record<string, unknown>,
  ): Promise<RemoteFuzzyFileSearchResult> {
    const query = params.query;
    if (
      typeof query !== "string" ||
      query.includes("\0") ||
      query.length > MAX_FUZZY_QUERY_LENGTH
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        `params.query must be a NUL-free string of at most ${MAX_FUZZY_QUERY_LENGTH} characters`,
      );
    }
    const requestedMaxResults = params.maxResults ?? 100;
    if (
      typeof requestedMaxResults !== "number" ||
      !Number.isInteger(requestedMaxResults) ||
      requestedMaxResults < 1 ||
      requestedMaxResults > MAX_FUZZY_FILE_RESULTS
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        `params.maxResults must be an integer between 1 and ${MAX_FUZZY_FILE_RESULTS}`,
      );
    }
    const config = this.#config();
    const root = config?.roots.find((candidate) => candidate.id === rootId);
    if (
      !config ||
      config.connectionMode !== "vscode-remote" ||
      !root ||
      root.target !== "remote" ||
      root.role !== "primary" ||
      root.path !== config.workspaceRoot
    ) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Remote file search does not match the active workspace",
      );
    }
    const remote = detectRemoteWorkspace();
    if (
      remote.host !== config.host ||
      remote.workspaceRoot !== config.workspaceRoot
    ) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "The active Remote SSH workspace no longer matches the Bridge session",
      );
    }
    if (query.trim().replace(/^@/, "").length === 0) {
      return { files: [], scannedFileCount: 0, truncated: false };
    }

    const candidates = await vscode.workspace.findFiles(
      new vscode.RelativePattern(remote.workspaceUri, fuzzySearchGlob(query)),
      undefined,
      MAX_FUZZY_FILE_CANDIDATES + 1,
    );
    const truncated = candidates.length > MAX_FUZZY_FILE_CANDIDATES;
    const matches: FuzzyFileSearchMatch[] = [];
    for (const uri of candidates.slice(0, MAX_FUZZY_FILE_CANDIDATES)) {
      if (
        uri.scheme !== remote.workspaceUri.scheme ||
        uri.authority !== remote.workspaceUri.authority
      ) {
        continue;
      }
      let relativePath: string;
      try {
        relativePath = workspaceRelativePath(root.path, uri.path, "remote");
      } catch {
        continue;
      }
      const match = fuzzyMatch(relativePath, query);
      if (match) {
        matches.push({ ...match, root: root.path });
      }
    }
    matches.sort(
      (left, right) => right.score - left.score || left.path.localeCompare(right.path),
    );
    return {
      files: matches.slice(0, requestedMaxResults),
      scannedFileCount: Math.min(candidates.length, MAX_FUZZY_FILE_CANDIDATES),
      truncated,
    };
  }

  #resolveRemoteEditor(uri: vscode.Uri): ResolvedResource {
    const config = this.#config();
    if (!config || config.connectionMode !== "vscode-remote") {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "Remote editor context requires an active VS Code Remote session",
      );
    }
    const root = config.roots.find(
      (candidate) => candidate.target === "remote" && candidate.role === "primary",
    );
    if (!root || root.path !== config.workspaceRoot) {
      throw new BridgeError("INVALID_CONFIG", "Remote primary root is unavailable");
    }
    const remote = detectRemoteWorkspace();
    if (
      remote.host !== config.host ||
      remote.workspaceRoot !== config.workspaceRoot
    ) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "The active Remote SSH workspace no longer matches the Bridge session",
      );
    }
    if (
      uri.scheme !== remote.workspaceUri.scheme ||
      uri.authority !== remote.workspaceUri.authority
    ) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Editor context does not belong to the active Remote SSH workspace",
      );
    }
    const relativePath = workspaceRelativePath(root.path, uri.path, "remote");
    const identity: WorkspaceResourceIdentity = {
      host: config.host,
      relativePath,
      rootId: root.id,
      target: "remote",
    };
    return {
      actualUri: uri,
      identity,
      resourceUri: vscode.Uri.parse(buildWorkspaceResourceUri(identity)),
      root,
    };
  }

  async #open(
    resolved: ResolvedResource,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const line = optionalPosition(params, "line");
    const column = optionalPosition(params, "column") ?? 1;
    const endLine = optionalPosition(params, "endLine") ?? line;
    const endColumn = optionalPosition(params, "endColumn") ?? column;
    if (line === undefined && params.column !== undefined) {
      throw new BridgeError("PROTOCOL_MISMATCH", "params.line is required with column");
    }
    if (line === undefined && (params.endLine !== undefined || params.endColumn !== undefined)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "params.line is required with an end position");
    }
    if (line !== undefined && endLine !== undefined && endLine < line) {
      throw new BridgeError("PROTOCOL_MISMATCH", "The selection end precedes its start");
    }
    if (
      line !== undefined &&
      endLine === line &&
      endColumn !== undefined &&
      endColumn < column
    ) {
      throw new BridgeError("PROTOCOL_MISMATCH", "The selection end precedes its start");
    }

    const document = await vscode.workspace.openTextDocument(resolved.actualUri);
    const selection =
      line === undefined
        ? undefined
        : new vscode.Range(
            line - 1,
            column - 1,
            (endLine ?? line) - 1,
            (endColumn ?? column) - 1,
          );
    await vscode.window.showTextDocument(document, {
      preview: true,
      ...(selection ? { selection } : {}),
    });
    this.#rememberResource(resolved);
    return this.#result("opened", resolved);
  }

  async #showDiff(
    resolved: ResolvedResource,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const beforeHash = requiredString(params, "beforeHash");
    if (!/^[0-9a-f]{64}$/.test(beforeHash)) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "params.beforeHash must be a SHA-256 digest",
      );
    }
    if (typeof params.beforeContentBase64 !== "string") {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "params.beforeContentBase64 must be a string",
      );
    }
    const content = decodeSnapshot(params.beforeContentBase64);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== beforeHash) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "The Diff before snapshot does not match beforeHash",
        { actualHash, beforeHash },
      );
    }
    const text = decodeText(content, "Diff before snapshot");
    const snapshotIdentity = { ...resolved.identity, revision: beforeHash };
    const snapshotUri = vscode.Uri.parse(buildWorkspaceResourceUri(snapshotIdentity));
    this.#rememberSnapshot(
      snapshotUri.toString(),
      text,
      content.byteLength,
      resolved,
    );
    this.#rememberResource(resolved);

    const requestedTitle = params.title;
    if (
      requestedTitle !== undefined &&
      (typeof requestedTitle !== "string" ||
        requestedTitle.length < 1 ||
        requestedTitle.length > 200 ||
        /[\r\n\0]/.test(requestedTitle))
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "params.title must contain 1 to 200 single-line characters",
      );
    }
    const title =
      typeof requestedTitle === "string"
        ? requestedTitle
        : `${resolved.identity.relativePath} (before <-> workspace)`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      snapshotUri,
      resolved.actualUri,
      title,
      { preview: true },
    );
    return {
      ...this.#result("diffed", resolved),
      beforeHash,
      snapshotUri: snapshotUri.toString(),
    };
  }

  #resolve(
    rootId: string,
    candidatePath: string,
    expectedIdentity?: WorkspaceResourceIdentity,
    threadId?: string,
  ): ResolvedResource {
    const config = this.#config();
    if (!config || config.connectionMode !== "vscode-remote") {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "Workspace resources require an active VS Code Remote session",
      );
    }
    const root =
      config.roots.find((entry) => entry.id === rootId) ??
      (threadId ? this.#resolveAuthorizedRoot(threadId, rootId) : undefined);
    if (!root) {
      throw new BridgeError("COMMAND_DENIED", "The workspace resource root is not configured");
    }
    const relativePath =
      root.role === "conversation" && root.kind === "file"
        ? (() => {
            const candidate = vscode.Uri.file(candidatePath).fsPath;
            if (candidate !== root.path) {
              throw new BridgeError(
                "PATH_OUTSIDE_ROOT",
                "Workspace resource is outside the exact file shared with this conversation",
              );
            }
            return basename(root.path);
          })()
        : workspaceRelativePath(root.path, candidatePath, root.target);
    const identity: WorkspaceResourceIdentity = {
      host: config.host,
      relativePath,
      rootId: root.id,
      target: root.target,
    };
    if (
      expectedIdentity &&
      (expectedIdentity.host !== identity.host ||
        expectedIdentity.rootId !== identity.rootId ||
        expectedIdentity.target !== identity.target ||
        expectedIdentity.relativePath !== identity.relativePath)
    ) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Workspace resource identity no longer matches the active configuration",
      );
    }

    let actualUri: vscode.Uri;
    if (root.target === "remote") {
      if (root.role !== "primary" || root.path !== config.workspaceRoot) {
        throw new BridgeError("INVALID_CONFIG", "Remote workspace resource root is invalid");
      }
      const remote = detectRemoteWorkspace();
      if (
        remote.host !== config.host ||
        remote.workspaceRoot !== config.workspaceRoot
      ) {
        throw new BridgeError(
          "COMMAND_DENIED",
          "Workspace resource does not match the open Remote SSH workspace",
        );
      }
      actualUri = vscode.Uri.joinPath(remote.workspaceUri, ...relativePath.split("/"));
    } else {
      const authorized = this.#resolveAuthorizedRoot(threadId ?? "", root.id);
      const secondaryAuthorized =
        root.role === "secondary" &&
        authorized?.role === "secondary" &&
        authorized.target === "local" &&
        authorized.path === root.path;
      const conversationAuthorized =
        root.role === "conversation" &&
        authorized?.role === "conversation" &&
        authorized.target === "local" &&
        authorized.path === root.path &&
        authorized.threadId === threadId;
      if (!secondaryAuthorized && !conversationAuthorized) {
        throw new BridgeError(
          "COMMAND_DENIED",
          "The local workspace resource authorization is no longer valid",
        );
      }
      actualUri =
        root.role === "conversation" && root.kind === "file"
          ? vscode.Uri.file(root.path)
          : vscode.Uri.joinPath(vscode.Uri.file(root.path), ...relativePath.split("/"));
    }
    const resourceUri = vscode.Uri.parse(buildWorkspaceResourceUri(identity));
    return {
      actualUri,
      identity,
      ...(root.target === "local" ? { localPath: candidatePath, threadId } : {}),
      resourceUri,
      root,
    };
  }

  async #assertStillAuthorized(resolved: ResolvedResource): Promise<void> {
    const config = this.#config();
    if (!config || config.connectionMode !== "vscode-remote") {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "Workspace resources require an active VS Code Remote session",
      );
    }
    if (resolved.root.target === "remote") {
      const configured = config.roots.find(
        (root) =>
          root.id === resolved.root.id &&
          root.target === "remote" &&
          root.role === "primary" &&
          root.path === resolved.root.path,
      );
      const remote = detectRemoteWorkspace();
      if (
        !configured ||
        remote.host !== config.host ||
        remote.workspaceRoot !== config.workspaceRoot
      ) {
        throw new BridgeError(
          "COMMAND_DENIED",
          "Workspace resource no longer matches the active Remote SSH workspace",
        );
      }
      return;
    }
    const authorized = this.#resolveAuthorizedRoot(
      resolved.threadId ?? "",
      resolved.root.id,
    );
    const secondaryAuthorized =
      resolved.root.role === "secondary" &&
      authorized?.role === "secondary" &&
      authorized.path === resolved.root.path;
    const conversationAuthorized =
      resolved.root.role === "conversation" &&
      authorized?.role === "conversation" &&
      authorized.threadId === resolved.threadId &&
      authorized.path === resolved.root.path &&
      authorized.kind === resolved.root.kind;
    if ((!secondaryAuthorized && !conversationAuthorized) || !resolved.localPath) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "The local workspace resource authorization is no longer valid",
      );
    }
    try {
      const [canonicalPath, metadata] = await Promise.all([
        realpath(resolved.localPath),
        stat(resolved.localPath),
      ]);
      if (canonicalPath !== resolved.localPath || !metadata.isFile()) {
        throw new BridgeError(
          "COMMAND_DENIED",
          "The local workspace resource no longer resolves to the registered file",
        );
      }
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "COMMAND_DENIED",
        "The local workspace resource is no longer available",
        undefined,
        { cause: error },
      );
    }
  }

  #rememberSnapshot(
    uri: string,
    content: string,
    size: number,
    resolved: ResolvedResource,
  ): void {
    const previous = this.#snapshots.get(uri);
    if (previous) {
      this.#snapshotBytes -= previous.size;
      this.#snapshots.delete(uri);
    }
    this.#snapshots.set(uri, { content, resolved, size });
    this.#snapshotBytes += size;
    while (
      this.#snapshots.size > MAX_SNAPSHOT_COUNT ||
      this.#snapshotBytes > MAX_TOTAL_SNAPSHOT_BYTES
    ) {
      const oldest = this.#snapshots.entries().next().value as
        | [string, Snapshot]
        | undefined;
      if (!oldest) {
        break;
      }
      this.#snapshots.delete(oldest[0]);
      this.#snapshotBytes -= oldest[1].size;
    }
  }

  #rememberResource(resolved: ResolvedResource): void {
    const uri = resolved.resourceUri.toString();
    this.#resources.delete(uri);
    this.#resources.set(uri, resolved);
    while (this.#resources.size > 256) {
      const oldest = this.#resources.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.#resources.delete(oldest);
    }
  }

  #result(
    action: "diffed" | "opened" | "registered",
    resolved: ResolvedResource,
  ): Record<string, unknown> {
    return {
      action,
      relativePath: resolved.identity.relativePath,
      resourceUri: resolved.resourceUri.toString(),
      rootId: resolved.root.id,
      target: resolved.root.target,
      workspaceUri: resolved.actualUri.toString(),
    };
  }
}
