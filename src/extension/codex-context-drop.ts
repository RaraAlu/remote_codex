import * as posix from "node:path/posix";
import * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";
import {
  CODEX_INLINE_MENTION_PATH_MARKER,
  CODEX_REMOTE_INLINE_MENTION_PATH_PREFIX,
} from "./codex-inline-mention-patch.js";
import {
  detectRemoteWorkspace,
  type RemoteWorkspaceContext,
} from "./remote-context.js";

const OFFICIAL_ADD_FILE_COMMAND = "chatgpt.addFileToThread";
const MAX_DROPPED_RESOURCES = 128;
const MAX_TRANSFER_TEXT_LENGTH = 1024 * 1024;
const MAX_NATIVE_PATH_LENGTH = 32 * 1024;

export type CodexContextDropLog = (message: string) => void;
export type WorkbenchDropSource = "system-file-manager" | "vscode-explorer";

export interface WorkbenchDropPayload {
  schemaVersion: 1;
  codeFiles?: string;
  internalUriList?: string;
  nativeFilePaths?: string[];
  resourceUrls?: string;
  uriList?: string;
}

export interface CodexContextDropResult {
  attachedCount: number;
  directoryCount: number;
  duplicateCount: number;
  failedCount: number;
  fileCount: number;
  localCount: number;
  remoteCount: number;
  firstFailure: string | null;
}

export interface ParsedWorkbenchDrop {
  resources: vscode.Uri[];
  source: WorkbenchDropSource;
}

export interface CodexContextDropOptions {
  log?: CodexContextDropLog;
}

type WorkbenchDropField =
  | "codeFiles"
  | "internalUriList"
  | "nativeFilePaths"
  | "resourceUrls"
  | "uriList";

interface WorkbenchDropCandidate {
  field: WorkbenchDropField;
  uri: vscode.Uri;
}

function parseUriList(value: string): vscode.Uri[] {
  if (value.length > MAX_TRANSFER_TEXT_LENGTH) {
    return [];
  }
  const resources: vscode.Uri[] = [];
  for (const line of value.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate || candidate.startsWith("#")) {
      continue;
    }
    try {
      resources.push(vscode.Uri.parse(candidate));
    } catch {
      // Ignore malformed entries while preserving valid resources in the same drop.
    }
  }
  return resources;
}

function parseResourceUrls(value: string): vscode.Uri[] {
  if (value.length > MAX_TRANSFER_TEXT_LENGTH) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) =>
      typeof entry === "string" ? parseUriList(entry) : [],
    );
  } catch {
    return [];
  }
}

function resourceKey(uri: vscode.Uri): string {
  const value = uri.with({ fragment: "" }).toString(true);
  return process.platform === "win32" && uri.scheme === "file"
    ? value.toLowerCase()
    : value;
}

function logDrop(log: CodexContextDropLog | undefined, message: string): void {
  try {
    log?.(message);
  } catch {
    // Diagnostics must never change drag-and-drop behavior.
  }
}

function formatUri(uri: vscode.Uri): string {
  return [
    `uri=${JSON.stringify(uri.toString(true))}`,
    `scheme=${JSON.stringify(uri.scheme)}`,
    `authority=${JSON.stringify(uri.authority)}`,
    `path=${JSON.stringify(uri.path)}`,
    `fsPath=${JSON.stringify(uri.fsPath)}`,
  ].join(" ");
}

function parseFilePaths(value: string): vscode.Uri[] {
  if (value.length > MAX_TRANSFER_TEXT_LENGTH) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.flatMap((entry) =>
          typeof entry === "string" && entry.length > 0 ? [vscode.Uri.file(entry)] : [],
        )
      : [];
  } catch {
    return [];
  }
}

function tryDetectRemoteWorkspace(): RemoteWorkspaceContext | null {
  try {
    return detectRemoteWorkspace();
  } catch {
    return null;
  }
}

function normalizedRemotePathWithinRoot(
  remote: RemoteWorkspaceContext,
  candidatePath: string,
): string | null {
  if (!posix.isAbsolute(candidatePath)) {
    return null;
  }
  const root = posix.normalize(remote.workspaceRoot);
  const candidate = posix.normalize(candidatePath);
  const relative = posix.relative(root, candidate);
  return relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)
    ? null
    : candidate;
}

function normalizeRemoteExplorerCandidates(
  candidates: readonly WorkbenchDropCandidate[],
  source: WorkbenchDropSource,
  log?: CodexContextDropLog,
): WorkbenchDropCandidate[] {
  if (source !== "vscode-explorer") {
    return [...candidates];
  }
  const remote = tryDetectRemoteWorkspace();
  if (!remote) {
    return [...candidates];
  }
  const explicitRemotePaths = new Set(
    candidates.flatMap(({ uri }) => {
      if (
        uri.scheme !== remote.workspaceUri.scheme ||
        uri.authority !== remote.workspaceUri.authority
      ) {
        return [];
      }
      const path = normalizedRemotePathWithinRoot(remote, uri.path);
      return path ? [path] : [];
    }),
  );
  return candidates.map((candidate) => {
    if (candidate.uri.scheme !== "file") {
      return candidate;
    }
    const remotePath = normalizedRemotePathWithinRoot(remote, candidate.uri.path);
    if (
      !remotePath ||
      (candidate.field !== "codeFiles" && !explicitRemotePaths.has(remotePath))
    ) {
      return candidate;
    }
    const uri = remote.workspaceUri.with({
      fragment: "",
      path: remotePath,
      query: "",
    });
    logDrop(
      log,
      `phase.drop.remote-map field=${JSON.stringify(candidate.field)} from=${JSON.stringify(candidate.uri.toString(true))} to=${JSON.stringify(uri.toString(true))}`,
    );
    return { ...candidate, uri };
  });
}

function validatePayload(payload: unknown): WorkbenchDropPayload {
  if (!payload || typeof payload !== "object") {
    throw new BridgeError("COMMAND_DENIED", "Workbench drop payload must be an object");
  }
  const candidate = payload as Partial<WorkbenchDropPayload>;
  if (candidate.schemaVersion !== 1) {
    throw new BridgeError("COMMAND_DENIED", "Unsupported Workbench drop payload schema");
  }
  for (const field of ["codeFiles", "internalUriList", "resourceUrls", "uriList"] as const) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== "string") {
      throw new BridgeError("COMMAND_DENIED", `Workbench drop field ${field} must be text`);
    }
    if (typeof value === "string" && value.length > MAX_TRANSFER_TEXT_LENGTH) {
      throw new BridgeError("OUTPUT_TRUNCATED", `Workbench drop field ${field} is too large`);
    }
  }
  if (
    candidate.nativeFilePaths !== undefined &&
    (!Array.isArray(candidate.nativeFilePaths) ||
      candidate.nativeFilePaths.length > MAX_DROPPED_RESOURCES ||
      candidate.nativeFilePaths.some(
        (entry) =>
          typeof entry !== "string" ||
          entry.length === 0 ||
          entry.length > MAX_NATIVE_PATH_LENGTH,
      ))
  ) {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Workbench native file paths must be non-empty strings",
    );
  }
  return candidate as WorkbenchDropPayload;
}

export function parseWorkbenchDropPayload(
  untrustedPayload: unknown,
  log?: CodexContextDropLog,
): ParsedWorkbenchDrop {
  const payload = validatePayload(untrustedPayload);
  const candidates: WorkbenchDropCandidate[] = [];
  for (const [field, value] of [
    ["internalUriList", payload.internalUriList],
    ["uriList", payload.uriList],
  ] as const) {
    if (value) {
      const parsed = parseUriList(value);
      logDrop(log, `phase.drop.parse field=${JSON.stringify(field)} uriCount=${parsed.length}`);
      candidates.push(...parsed.map((uri) => ({ field, uri })));
    }
  }
  if (payload.resourceUrls) {
    const parsed = parseResourceUrls(payload.resourceUrls);
    logDrop(
      log,
      `phase.drop.parse field="resourceUrls" uriCount=${parsed.length}`,
    );
    candidates.push(...parsed.map((uri) => ({ field: "resourceUrls" as const, uri })));
  }
  if (payload.codeFiles) {
    const parsed = parseFilePaths(payload.codeFiles);
    logDrop(log, `phase.drop.parse field="codeFiles" uriCount=${parsed.length}`);
    candidates.push(...parsed.map((uri) => ({ field: "codeFiles" as const, uri })));
  }
  for (const filePath of payload.nativeFilePaths ?? []) {
    candidates.push({ field: "nativeFilePaths", uri: vscode.Uri.file(filePath) });
  }

  const sourceEvidence = [
    ["internalUriList", payload.internalUriList],
    ["resourceUrls", payload.resourceUrls],
    ["codeFiles", payload.codeFiles],
  ] as const;
  const evidence = sourceEvidence.flatMap(([field, value]) =>
    typeof value === "string" && value.length > 0 ? [field] : [],
  );
  const source: WorkbenchDropSource =
    evidence.length > 0 || candidates.some(({ uri }) => uri.scheme === "vscode-remote")
      ? "vscode-explorer"
      : "system-file-manager";
  logDrop(
    log,
    `phase.drop.source source=${JSON.stringify(source)} evidence=${JSON.stringify(evidence)}`,
  );
  const normalizedCandidates = normalizeRemoteExplorerCandidates(candidates, source, log);
  const resources = normalizedCandidates.map(({ uri }) => uri);

  const seen = new Set<string>();
  const unique = resources.filter((resource) => {
    const key = resourceKey(resource);
    if (seen.has(key)) {
      logDrop(log, `phase.drop.deduplicate ${formatUri(resource)}`);
      return false;
    }
    seen.add(key);
    return true;
  });
  unique.forEach((resource, index) => {
    logDrop(log, `phase.drop.resource index=${index} ${formatUri(resource)}`);
  });
  logDrop(
    log,
    `phase.drop.parse-complete rawCount=${resources.length} uniqueCount=${unique.length}`,
  );
  return { resources: unique, source };
}

export function extractWorkbenchDropPayloadUris(
  untrustedPayload: unknown,
  log?: CodexContextDropLog,
): vscode.Uri[] {
  return parseWorkbenchDropPayload(untrustedPayload, log).resources;
}

function remoteAttachmentPath(uri: vscode.Uri): string {
  const remote = detectRemoteWorkspace();
  if (
    uri.scheme !== remote.workspaceUri.scheme ||
    uri.authority !== remote.workspaceUri.authority
  ) {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Dropped remote resource does not belong to the active Remote SSH workspace",
    );
  }
  const candidate = normalizedRemotePathWithinRoot(remote, uri.path);
  if (!candidate) {
    throw new BridgeError(
      "PATH_OUTSIDE_ROOT",
      "Dropped remote resource is outside the active Remote SSH workspace",
    );
  }
  return candidate;
}

function remoteInlineMentionTransportPath(
  remotePath: string,
  directory: boolean,
): string {
  const normalized = directory && remotePath !== "/"
    ? remotePath.replace(/\/+$/, "")
    : remotePath;
  const encoded = encodeURIComponent(normalized);
  return `/${CODEX_REMOTE_INLINE_MENTION_PATH_PREFIX}${encoded}${CODEX_INLINE_MENTION_PATH_MARKER}${directory ? "/" : ""}`;
}

function asOfficialFileUri(
  uri: vscode.Uri,
  directory: boolean,
): vscode.Uri {
  if (uri.scheme === "vscode-remote") {
    return vscode.Uri.file(
      remoteInlineMentionTransportPath(remoteAttachmentPath(uri), directory),
    );
  }
  const rawPath = uri.fsPath;
  const separator = uri.scheme === "vscode-remote" || process.platform !== "win32" ? "/" : "\\";
  const contextPath =
    directory && !rawPath.endsWith(separator) ? `${rawPath}${separator}` : rawPath;
  const path = directory
    ? `${contextPath.slice(0, -separator.length)}${CODEX_INLINE_MENTION_PATH_MARKER}${separator}`
    : `${contextPath}${CODEX_INLINE_MENTION_PATH_MARKER}`;
  return vscode.Uri.file(path);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function attachDroppedResourcesToCodex(
  resources: readonly vscode.Uri[],
  options: CodexContextDropOptions = {},
): Promise<CodexContextDropResult> {
  const { log } = options;
  if (resources.length === 0) {
    throw new BridgeError("COMMAND_DENIED", "The drop did not contain a file or folder path");
  }
  if (resources.length > MAX_DROPPED_RESOURCES) {
    throw new BridgeError(
      "OUTPUT_TRUNCATED",
      `One drop can contain at most ${MAX_DROPPED_RESOURCES} files or folders`,
    );
  }
  const commands = new Set(await vscode.commands.getCommands(true));
  if (!commands.has(OFFICIAL_ADD_FILE_COMMAND)) {
    throw new BridgeError(
      "COMMAND_DENIED",
      "The installed Codex extension does not expose its native file context command",
    );
  }
  logDrop(
    log,
    `phase.attach.capability command=${JSON.stringify(OFFICIAL_ADD_FILE_COMMAND)} available=true resourceCount=${resources.length} insertionMode="inline-mention"`,
  );

  const result: CodexContextDropResult = {
    attachedCount: 0,
    directoryCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    fileCount: 0,
    localCount: 0,
    remoteCount: 0,
    firstFailure: null,
  };
  const seen = new Set<string>();

  for (const [index, original] of resources.entries()) {
    try {
      logDrop(log, `phase.attach.resource index=${index} ${formatUri(original)}`);
      if (original.scheme !== "file" && original.scheme !== "vscode-remote") {
        throw new BridgeError(
          "COMMAND_DENIED",
          `Unsupported dropped resource scheme: ${original.scheme}`,
        );
      }
      const resource = original.with({ fragment: "" });
      const metadata = await vscode.workspace.fs.stat(resource);
      const directory = (metadata.type & vscode.FileType.Directory) !== 0;
      logDrop(
        log,
        `phase.attach.stat index=${index} type=${metadata.type} kind=${directory ? "directory" : "file"} size=${metadata.size}`,
      );
      const attachment = asOfficialFileUri(resource, directory);
      logDrop(
        log,
        `phase.attach.map index=${index} source=${JSON.stringify(original.scheme === "vscode-remote" ? "remote-workspace" : "local-file")} insertionMode="inline-mention" official=${formatUri(attachment)}`,
      );
      const key = process.platform === "win32"
        ? attachment.fsPath.toLowerCase()
        : attachment.fsPath;
      if (seen.has(key)) {
        result.duplicateCount += 1;
        logDrop(log, `phase.attach.duplicate index=${index} key=${JSON.stringify(key)}`);
        continue;
      }
      seen.add(key);

      logDrop(
        log,
        `phase.attach.command index=${index} command=${JSON.stringify(OFFICIAL_ADD_FILE_COMMAND)} argument=${JSON.stringify(attachment.toString(true))}`,
      );
      await vscode.commands.executeCommand(OFFICIAL_ADD_FILE_COMMAND, attachment);
      logDrop(log, `phase.attach.success index=${index}`);
      result.attachedCount += 1;
      if (directory) {
        result.directoryCount += 1;
      } else {
        result.fileCount += 1;
      }
      if (original.scheme === "vscode-remote") {
        result.remoteCount += 1;
      } else {
        result.localCount += 1;
      }
    } catch (error) {
      result.failedCount += 1;
      result.firstFailure ??= failureMessage(error);
      logDrop(
        log,
        `phase.attach.failure index=${index} error=${JSON.stringify(failureMessage(error))}`,
      );
    }
  }
  logDrop(
    log,
    `phase.attach.complete attached=${result.attachedCount} failed=${result.failedCount} duplicates=${result.duplicateCount} files=${result.fileCount} directories=${result.directoryCount} local=${result.localCount} remote=${result.remoteCount}`,
  );
  return result;
}
