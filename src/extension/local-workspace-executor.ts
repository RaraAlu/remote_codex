import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile as readFileBytes, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BridgeError } from "../core/errors.js";
import type {
  DirectoryEntry,
  SearchMatch,
  TreeEntry,
  TreeListing,
} from "../core/ssh-executor.js";
import type {
  RemoteCommandResult,
  RemoteFileRead,
  WorkspaceRootConfig,
} from "../core/types.js";
import type { WorkspaceExecutor } from "../core/workspace-executor.js";

export interface LocalWorkspaceExecutorOptions {
  commandTimeoutMs: number;
  maxDirectoryEntries?: number;
  maxFileBytes?: number;
  maxOutputBytes: number;
  maxSearchBytes?: number;
  maxSearchEntries?: number;
}

export type LocalRootResolver = (rootId: string) => WorkspaceRootConfig | undefined;

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

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly rootId: string;
  readonly #commandTimeoutMs: number;
  readonly #maxDirectoryEntries: number;
  readonly #maxFileBytes: number;
  readonly #maxOutputBytes: number;
  readonly #maxSearchBytes: number;
  readonly #maxSearchEntries: number;
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
  }

  async canonicalPath(inputPath: string): Promise<string> {
    const root = await this.#canonicalRoot();
    if (typeof inputPath !== "string" || inputPath.includes("\0")) {
      throw new BridgeError("PATH_OUTSIDE_ROOT", "Local path must be a NUL-free string");
    }
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

  async #canonicalRoot(): Promise<string> {
    const root = this.#resolveRoot(this.rootId);
    if (!root || root.target !== "local" || root.role !== "secondary") {
      throw new BridgeError("COMMAND_DENIED", "The local root authorization was revoked", {
        rootId: this.rootId,
      });
    }
    try {
      const canonicalRoot = await realpath(root.path);
      const metadata = await stat(canonicalRoot);
      if (canonicalRoot !== root.path || !metadata.isDirectory()) {
        throw new BridgeError(
          "COMMAND_DENIED",
          "The authorized local root no longer resolves to the selected directory",
          { rootId: this.rootId },
        );
      }
      return canonicalRoot;
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "COMMAND_DENIED",
        "The authorized local root is unavailable",
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
