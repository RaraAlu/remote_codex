import { execFile, type ExecFileException } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile as readFileBytes,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "../core/errors.js";
import type {
  DirectoryEntry,
  SearchMatch,
  TreeEntry,
  TreeListing,
} from "../core/ssh-executor.js";
import type {
  ConversationResourceConfig,
  RemoteCommandResult,
  RemoteFileRead,
  WorkspaceMutationResult,
  WorkspacePatchReplacement,
  WorkspaceRootConfig,
} from "../core/types.js";
import type {
  WorkspaceExecutor,
  WorkspaceMutationOptions,
} from "../core/workspace-executor.js";
import {
  applyWorkspacePatch,
  decodeWorkspaceContent,
  MAX_WORKSPACE_WRITE_BYTES,
  validateExpectedHash,
} from "../core/workspace-mutations.js";

export interface LocalWorkspaceExecutorOptions {
  commandTimeoutMs: number;
  maxDirectoryEntries?: number;
  maxFileBytes?: number;
  maxOutputBytes: number;
  maxSearchBytes?: number;
  maxSearchEntries?: number;
}

export type LocalWorkspaceScope = WorkspaceRootConfig | ConversationResourceConfig;
export type LocalRootResolver = (rootId: string) => LocalWorkspaceScope | undefined;

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function entryType(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DirectoryEntry["type"] {
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  return "other";
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  return environment;
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly rootId: string;
  readonly #commandTimeoutMs: number;
  readonly #maxDirectoryEntries: number;
  readonly #maxFileBytes: number;
  readonly #maxOutputBytes: number;
  readonly #maxSearchBytes: number;
  readonly #maxSearchEntries: number;
  readonly #maxWriteBytes: number;
  readonly #resolveRoot: LocalRootResolver;

  constructor(
    rootId: string,
    resolveRoot: LocalRootResolver,
    options: LocalWorkspaceExecutorOptions,
  ) {
    this.rootId = rootId;
    this.#resolveRoot = resolveRoot;
    this.#commandTimeoutMs = options.commandTimeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#maxDirectoryEntries = options.maxDirectoryEntries ?? 2_000;
    this.#maxFileBytes = options.maxFileBytes ?? Math.min(options.maxOutputBytes * 8, 100 * 1024 * 1024);
    this.#maxSearchBytes = options.maxSearchBytes ?? Math.min(options.maxOutputBytes * 8, 64 * 1024 * 1024);
    this.#maxSearchEntries = options.maxSearchEntries ?? 20_000;
    this.#maxWriteBytes = Math.min(
      MAX_WORKSPACE_WRITE_BYTES,
      Math.max(1, options.maxOutputBytes),
    );
  }

  async canonicalPath(inputPath: string): Promise<string> {
    if (typeof inputPath !== "string" || inputPath.includes("\0")) {
      throw new BridgeError("PATH_OUTSIDE_ROOT", "Local path must be a NUL-free string");
    }
    const scope = await this.#canonicalScope();
    if (scope.resource.role === "conversation" && scope.resource.kind === "file") {
      const lexicalPath =
        inputPath === "" || inputPath === "."
          ? scope.path
          : resolve(dirname(scope.path), inputPath);
      if (lexicalPath !== scope.path) {
        throw new BridgeError(
          "PATH_OUTSIDE_ROOT",
          "Local path escapes the exact file shared with this conversation",
          { path: inputPath, rootId: this.rootId },
        );
      }
      return scope.path;
    }
    const root = scope.path;
    const lexicalPath = resolve(root, inputPath || ".");
    if (!isPathInside(root, lexicalPath)) {
      throw new BridgeError("PATH_OUTSIDE_ROOT", "Local path escapes the authorized root", {
        path: inputPath,
        rootId: this.rootId,
      });
    }
    try {
      const canonicalPath = await realpath(lexicalPath);
      if (!isPathInside(root, canonicalPath)) {
        throw new BridgeError(
          "PATH_OUTSIDE_ROOT",
          "Resolved local path escapes the authorized root",
          {
            path: inputPath,
            rootId: this.rootId,
          },
        );
      }
      return canonicalPath;
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local path does not exist or cannot be resolved",
        { path: inputPath, rootId: this.rootId },
        { cause: error },
      );
    }
  }

  async readFile(
    inputPath: string,
    limitBytes = this.#maxOutputBytes / 2,
  ): Promise<RemoteFileRead> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const handle = await open(canonicalPath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new BridgeError("COMMAND_DENIED", "The requested local path is not a file");
      }
      if (before.size > this.#maxFileBytes) {
        throw new BridgeError("OUTPUT_TRUNCATED", "Local file exceeds the configured read limit", {
          limitBytes: this.#maxFileBytes,
          size: before.size,
        });
      }

      const safeLimit = Math.max(
        1,
        Math.min(Math.floor(limitBytes), Math.floor(this.#maxOutputBytes / 2)),
      );
      const prefix = Buffer.alloc(Math.min(before.size, safeLimit));
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
      const hash = createHash("sha256");
      let position = 0;
      let prefixOffset = 0;
      while (position < before.size) {
        const length = Math.min(chunk.length, before.size - position);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead === 0) {
          break;
        }
        const bytes = chunk.subarray(0, bytesRead);
        hash.update(bytes);
        if (prefixOffset < prefix.length) {
          const copyLength = Math.min(bytesRead, prefix.length - prefixOffset);
          bytes.copy(prefix, prefixOffset, 0, copyLength);
          prefixOffset += copyLength;
        }
        position += bytesRead;
      }
      const after = await handle.stat();
      if (
        position !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      ) {
        throw new BridgeError("COMMAND_DENIED", "Local file changed while it was being read");
      }
      return {
        canonicalPath,
        contentBase64: prefix.subarray(0, prefixOffset).toString("base64"),
        hash: hash.digest("hex"),
        mode: before.mode.toString(16),
        modifiedAtMs: before.mtimeMs,
        size: before.size,
        truncated: before.size > safeLimit,
      };
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    inputPath: string,
    contentBase64: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const content = decodeWorkspaceContent(contentBase64, this.#maxWriteBytes);
    const target = await this.#mutationTarget(inputPath);
    const existing = await this.#lstatIfPresent(target);
    if (existing?.isSymbolicLink()) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local mutation target must not be a symbolic link",
      );
    }
    if (existing && !existing.isFile()) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Workspace write target is not a regular file",
      );
    }
    const expectedHash = validateExpectedHash(options.expectedHash, Boolean(existing));
    if (!existing && expectedHash) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "Workspace file does not exist for the supplied expectedHash",
      );
    }
    if (existing) {
      const current = await this.readFile(inputPath, 1);
      if (current.hash !== expectedHash) {
        throw new BridgeError(
          "FILE_CONFLICT",
          "Workspace file changed since it was read",
          { actualHash: current.hash, expectedHash },
        );
      }
    }

    const temporaryPath = join(
      dirname(target),
      `.codex-bridge-write-${randomUUID()}.tmp`,
    );
    let temporaryExists = false;
    try {
      const handle = await open(
        temporaryPath,
        "wx",
        existing ? existing.mode & 0o777 : 0o600,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (existing) {
        const current = await this.readFile(inputPath, 1);
        if (current.hash !== expectedHash) {
          throw new BridgeError(
            "FILE_CONFLICT",
            "Workspace file changed before the atomic replacement",
            { actualHash: current.hash, expectedHash },
          );
        }
        await chmod(temporaryPath, existing.mode & 0o777);
        await rename(temporaryPath, target);
        temporaryExists = false;
      } else {
        try {
          await link(temporaryPath, target);
          await unlink(temporaryPath);
          temporaryExists = false;
        } catch (error) {
          if (nodeErrorCode(error) === "EEXIST") {
            throw new BridgeError(
              "FILE_CONFLICT",
              "Workspace file was created concurrently",
            );
          }
          throw error;
        }
      }
      await this.#syncDirectory(dirname(target));
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "COMMAND_DENIED",
        "Unable to atomically write the local workspace file",
        { path: inputPath },
        { cause: error },
      );
    } finally {
      if (temporaryExists) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }

    const metadata = await this.readFile(inputPath, 1);
    return {
      operation: "write",
      canonicalPath: metadata.canonicalPath,
      bytesWritten: content.length,
      hash: metadata.hash,
      mode: metadata.mode,
      modifiedAtMs: metadata.modifiedAtMs,
      size: metadata.size,
    };
  }

  async applyPatch(
    inputPath: string,
    replacements: readonly WorkspacePatchReplacement[],
    options: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult> {
    const expectedHash = validateExpectedHash(options.expectedHash, true);
    const current = await this.readFile(inputPath, this.#maxWriteBytes);
    if (current.truncated) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Workspace file exceeds the configured patch byte limit",
        { limitBytes: this.#maxWriteBytes, size: current.size },
      );
    }
    if (current.hash !== expectedHash) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "Workspace file changed since it was read",
        { actualHash: current.hash, expectedHash },
      );
    }
    const patched = applyWorkspacePatch(
      Buffer.from(current.contentBase64, "base64"),
      replacements,
    );
    if (patched.length > this.#maxWriteBytes) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Patched workspace file exceeds the configured write byte limit",
        { limitBytes: this.#maxWriteBytes, size: patched.length },
      );
    }
    const result = await this.writeFile(
      inputPath,
      patched.toString("base64"),
      options,
    );
    return { ...result, operation: "patch" };
  }

  async createDirectory(
    inputPath: string,
    _options: Omit<WorkspaceMutationOptions, "expectedHash"> = {},
  ): Promise<WorkspaceMutationResult> {
    const target = await this.#mutationTarget(inputPath);
    const existing = await this.#lstatIfPresent(target);
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new BridgeError(
          "PATH_OUTSIDE_ROOT",
          "Local mutation target must not be a symbolic link",
        );
      }
      if (!existing.isDirectory()) {
        throw new BridgeError(
          "FILE_CONFLICT",
          "Workspace directory target already exists as another type",
        );
      }
    } else {
      try {
        await mkdir(target, { mode: 0o700 });
        await this.#syncDirectory(dirname(target));
      } catch (error) {
        throw new BridgeError(
          nodeErrorCode(error) === "EEXIST" ? "FILE_CONFLICT" : "COMMAND_DENIED",
          "Unable to create the local workspace directory",
          { path: inputPath },
          { cause: error },
        );
      }
    }
    return {
      operation: "mkdir",
      canonicalPath: await this.canonicalPath(inputPath),
      bytesWritten: 0,
    };
  }

  async renamePath(
    inputPath: string,
    destinationPath: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const source = await this.canonicalPath(inputPath);
    const root = await this.#canonicalRoot();
    if (source === root) {
      throw new BridgeError("COMMAND_DENIED", "The authorized root cannot be renamed");
    }
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink()) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local mutation source must not be a symbolic link",
      );
    }
    const destination = await this.#mutationTarget(destinationPath);
    if (await this.#lstatIfPresent(destination)) {
      throw new BridgeError(
        "FILE_CONFLICT",
        "Workspace rename destination already exists",
      );
    }
    if (sourceMetadata.isFile()) {
      const expectedHash = validateExpectedHash(options.expectedHash, true);
      const current = await this.readFile(inputPath, 1);
      if (current.hash !== expectedHash) {
        throw new BridgeError(
          "FILE_CONFLICT",
          "Workspace file changed since it was read",
          { actualHash: current.hash, expectedHash },
        );
      }
    } else if (sourceMetadata.isDirectory()) {
      if (options.expectedHash !== undefined) {
        throw new BridgeError(
          "PROTOCOL_MISMATCH",
          "expectedHash is not valid when renaming a directory",
        );
      }
    } else {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Workspace rename supports only regular files and directories",
      );
    }
    try {
      await rename(source, destination);
      await this.#syncDirectory(dirname(source));
      if (dirname(destination) !== dirname(source)) {
        await this.#syncDirectory(dirname(destination));
      }
    } catch (error) {
      throw new BridgeError(
        nodeErrorCode(error) === "EEXIST" ? "FILE_CONFLICT" : "COMMAND_DENIED",
        "Unable to rename the local workspace path",
        { path: inputPath },
        { cause: error },
      );
    }
    return {
      operation: "rename",
      canonicalPath: source,
      destinationCanonicalPath: await this.canonicalPath(destinationPath),
      bytesWritten: 0,
    };
  }

  async deletePath(
    inputPath: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const root = await this.#canonicalRoot();
    if (canonicalPath === root) {
      throw new BridgeError("COMMAND_DENIED", "The authorized root cannot be deleted");
    }
    const metadata = await lstat(canonicalPath);
    if (metadata.isSymbolicLink()) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local mutation source must not be a symbolic link",
      );
    }
    try {
      if (metadata.isFile()) {
        const expectedHash = validateExpectedHash(options.expectedHash, true);
        const current = await this.readFile(inputPath, 1);
        if (current.hash !== expectedHash) {
          throw new BridgeError(
            "FILE_CONFLICT",
            "Workspace file changed since it was read",
            { actualHash: current.hash, expectedHash },
          );
        }
        await unlink(canonicalPath);
      } else if (metadata.isDirectory()) {
        if (options.expectedHash !== undefined) {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "expectedHash is not valid when deleting a directory",
          );
        }
        await rmdir(canonicalPath);
      } else {
        throw new BridgeError(
          "COMMAND_DENIED",
          "Workspace delete supports only regular files and empty directories",
        );
      }
      await this.#syncDirectory(dirname(canonicalPath));
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "COMMAND_DENIED",
        "Unable to delete the local workspace path",
        { path: inputPath },
        { cause: error },
      );
    }
    return {
      operation: "delete",
      canonicalPath,
      bytesWritten: 0,
    };
  }

  async listDirectory(inputPath: string): Promise<DirectoryEntry[]> {
    const canonicalPath = await this.canonicalPath(inputPath);
    let entries;
    try {
      entries = await readdir(canonicalPath, { withFileTypes: true });
    } catch (error) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Unable to list the local directory",
        { path: inputPath },
        { cause: error },
      );
    }
    if (entries.length > this.#maxDirectoryEntries) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Local directory contains more entries than the configured limit",
        { limit: this.#maxDirectoryEntries },
      );
    }
    return entries
      .map((entry) => ({ name: entry.name, type: entryType(entry) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listTree(inputPath: string, depth = 2, maxEntries = 400): Promise<TreeListing> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new BridgeError("COMMAND_DENIED", "The requested local tree root is not a directory");
    }
    const safeDepth = Math.max(1, Math.min(Math.floor(depth), 4));
    const safeMaxEntries = Math.max(
      1,
      Math.min(Math.floor(maxEntries), this.#maxDirectoryEntries),
    );
    const pending: Array<{ directory: string; level: number }> = [
      { directory: canonicalPath, level: 1 },
    ];
    const entries: TreeEntry[] = [];
    let truncated = false;
    while (pending.length > 0 && !truncated) {
      const current = pending.shift();
      if (!current) {
        break;
      }
      const children = (await readdir(current.directory, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      for (const child of children) {
        if (entries.length >= safeMaxEntries) {
          truncated = true;
          break;
        }
        const absolutePath = join(current.directory, child.name);
        const type = entryType(child);
        entries.push({
          path: relative(canonicalPath, absolutePath),
          type,
        });
        if (type === "directory" && current.level < safeDepth) {
          const canonicalChild = await realpath(absolutePath);
          if (!isPathInside(canonicalPath, canonicalChild)) {
            throw new BridgeError(
              "PATH_OUTSIDE_ROOT",
              "Resolved local directory escapes the authorized root",
            );
          }
          pending.push({ directory: canonicalChild, level: current.level + 1 });
        }
      }
    }
    return { entries, truncated };
  }

  async search(
    query: string,
    inputPaths: readonly string[] = ["."],
    maxResults = 200,
  ): Promise<SearchMatch[]> {
    if (!query || query.includes("\0")) {
      throw new BridgeError("COMMAND_DENIED", "Search query must be a non-empty NUL-free string");
    }
    const safeMaxResults = Math.max(1, Math.min(Math.floor(maxResults), 1_000));
    const files = await this.#searchFiles(
      inputPaths.length > 0 ? inputPaths : ["."],
    );
    const matches: SearchMatch[] = [];
    let scannedBytes = 0;
    for (const file of files) {
      const canonicalFile = await this.canonicalPath(file);
      const metadata = await stat(canonicalFile);
      if (!metadata.isFile()) {
        continue;
      }
      scannedBytes += metadata.size;
      if (scannedBytes > this.#maxSearchBytes) {
        throw new BridgeError("OUTPUT_TRUNCATED", "Local search exceeded the scan byte limit", {
          limitBytes: this.#maxSearchBytes,
        });
      }
      const content = await readFileBytes(canonicalFile);
      if (content.includes(0)) {
        continue;
      }
      const lines = content.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!line.includes(query)) {
          continue;
        }
        matches.push({
          path: canonicalFile,
          lineNumber: index + 1,
          lines: line.slice(0, 8_192),
        });
        if (matches.length >= safeMaxResults) {
          return matches;
        }
      }
    }
    return matches;
  }

  async gitStatus(): Promise<RemoteCommandResult> {
    const root = await this.#canonicalRoot();
    const startedAt = performance.now();
    return await new Promise<RemoteCommandResult>((resolveResult, reject) => {
      execFile(
        "git",
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "status",
          "--short",
          "--branch",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: gitEnvironment(),
          maxBuffer: this.#maxOutputBytes,
          timeout: this.#commandTimeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const durationMs = Math.round(performance.now() - startedAt);
          if (error?.killed) {
            reject(new BridgeError("TIMEOUT", "Local git status timed out", { durationMs }));
            return;
          }
          if (error && typeof error.code !== "number") {
            const executionError = error as ExecFileException;
            if (executionError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              reject(
                new BridgeError(
                  "OUTPUT_TRUNCATED",
                  "Local git status exceeded the output limit",
                ),
              );
            } else {
              reject(
                new BridgeError(
                  "COMMAND_DENIED",
                  `Unable to run local git status: ${executionError.message}`,
                  undefined,
                  { cause: error },
                ),
              );
            }
            return;
          }
          resolveResult({
            actualCwd: root,
            durationMs,
            exitCode: typeof error?.code === "number" ? error.code : 0,
            signal: error?.signal ?? null,
            stderr,
            stdout,
            truncated: false,
          });
        },
      );
    });
  }

  async #mutationTarget(inputPath: string): Promise<string> {
    const root = await this.#canonicalRoot();
    if (typeof inputPath !== "string" || inputPath.includes("\0")) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local mutation path must be a NUL-free string",
      );
    }
    const lexicalPath = resolve(root, inputPath || ".");
    if (!isPathInside(root, lexicalPath)) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local mutation path escapes the authorized root",
        { path: inputPath, rootId: this.rootId },
      );
    }
    const name = basename(lexicalPath);
    if (!name || name === "." || name === "..") {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Local mutation path must identify a child of the authorized root",
      );
    }
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(dirname(lexicalPath));
    } catch (error) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Local mutation parent does not exist or cannot be resolved",
        { path: inputPath, rootId: this.rootId },
        { cause: error },
      );
    }
    if (!isPathInside(root, canonicalParent)) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Resolved local mutation parent escapes the authorized root",
        { path: inputPath, rootId: this.rootId },
      );
    }
    return join(canonicalParent, name);
  }

  async #lstatIfPresent(path: string): Promise<Stats | null> {
    try {
      return await lstat(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is not supported on every Controller platform.
    }
  }

  async #canonicalRoot(): Promise<string> {
    const scope = await this.#canonicalScope();
    if (scope.resource.role === "conversation" && scope.resource.kind !== "directory") {
      throw new BridgeError(
        "COMMAND_DENIED",
        "This conversation resource is an exact file, not a directory root",
        { rootId: this.rootId },
      );
    }
    return scope.path;
  }

  async #canonicalScope(): Promise<{
    path: string;
    resource: LocalWorkspaceScope;
  }> {
    const root = this.#resolveRoot(this.rootId);
    if (
      !root ||
      root.target !== "local" ||
      (root.role !== "secondary" && root.role !== "conversation")
    ) {
      throw new BridgeError("COMMAND_DENIED", "The local workspace scope was revoked", {
        rootId: this.rootId,
      });
    }
    try {
      const canonicalRoot = await realpath(root.path);
      const metadata = await stat(canonicalRoot);
      const expectedKind = root.role === "conversation" ? root.kind : "directory";
      const kindMatches =
        expectedKind === "directory" ? metadata.isDirectory() : metadata.isFile();
      if (canonicalRoot !== root.path || !kindMatches) {
        throw new BridgeError(
          "COMMAND_DENIED",
          "The authorized local workspace scope no longer resolves to the selected resource",
          { rootId: this.rootId },
        );
      }
      return { path: canonicalRoot, resource: root };
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "COMMAND_DENIED",
        "The authorized local workspace scope is unavailable",
        { rootId: this.rootId },
        { cause: error },
      );
    }
  }

  async #searchFiles(inputPaths: readonly string[]): Promise<string[]> {
    const files: string[] = [];
    const pending: string[] = [];
    for (const inputPath of inputPaths) {
      const canonicalPath = await this.canonicalPath(inputPath);
      const metadata = await stat(canonicalPath);
      if (metadata.isFile()) {
        files.push(canonicalPath);
      } else if (metadata.isDirectory()) {
        pending.push(canonicalPath);
      }
    }
    let visitedEntries = files.length;
    while (pending.length > 0) {
      const directory = pending.shift();
      if (!directory) {
        break;
      }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      visitedEntries += entries.length;
      if (visitedEntries > this.#maxSearchEntries) {
        throw new BridgeError("OUTPUT_TRUNCATED", "Local search exceeded the entry limit", {
          limit: this.#maxSearchEntries,
        });
      }
      for (const entry of entries) {
        if (entry.name === ".git" || entry.isSymbolicLink()) {
          continue;
        }
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          const canonicalDirectory = await realpath(absolutePath);
          const root = await this.#canonicalRoot();
          if (!isPathInside(root, canonicalDirectory)) {
            throw new BridgeError(
              "PATH_OUTSIDE_ROOT",
              "Resolved local search directory escapes the authorized root",
            );
          }
          pending.push(canonicalDirectory);
        } else if (entry.isFile()) {
          files.push(absolutePath);
        }
      }
    }
    return files;
  }
}
