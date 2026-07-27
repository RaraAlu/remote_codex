import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BridgeError } from "./errors.js";
import { chmodSyncIfSupported } from "./file-permissions.js";
import { isPathInside, normalizeRemotePath } from "./path-policy.js";
import type {
  BridgeConfig,
  RemoteBackgroundLogResult,
  RemoteBackgroundTaskSummary,
  RemoteCommandResult,
  RemoteFileRead,
  RemoteIdentity,
  WorkspaceMutationResult,
  WorkspacePatchReplacement,
} from "./types.js";
import type { WorkspaceMutationOptions } from "./workspace-executor.js";
import {
  applyWorkspacePatch,
  decodeWorkspaceContent,
  MAX_WORKSPACE_WRITE_BYTES,
  validateExpectedHash,
} from "./workspace-mutations.js";

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ExecuteOptions {
  cwd?: string;
  env?: Record<string, string | null>;
  idempotencyKey?: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  sideEffect?: boolean;
  stdin?: Buffer;
  timeoutMs?: number;
}

export interface DirectoryEntry {
  name: string;
  type: "directory" | "file" | "other" | "symlink";
}

export interface TreeEntry {
  path: string;
  type: "directory" | "file" | "other" | "symlink";
}

export interface TreeListing {
  entries: TreeEntry[];
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  lines: string;
}

const REMOTE_WRAPPER = [
  "set -eu",
  'cd -- "$1"',
  "shift",
  'printf "%s\\0" "$(pwd -P)"',
  'exec "$@"',
].join("\n");

const REMOTE_WRITE_SCRIPT = [
  "set -eu",
  'root=$(realpath -e -- "$1")',
  'target=$2',
  'expected=$3',
  'max_bytes=$4',
  'expected_bytes=$5',
  'parent=$(realpath -e -- "$(dirname -- "$target")") || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'case "$parent" in "$root"|"$root"/*) ;; *) printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42 ;; esac',
  'target="$parent/$(basename -- "$target")"',
  '[ ! -L "$target" ] || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'exists=0',
  'mode=600',
  'if [ -e "$target" ]; then',
  '  exists=1',
  '  [ -f "$target" ] || { printf "%s\\n" "CODEX_BRIDGE:COMMAND_DENIED" >&2; exit 44; }',
  '  [ -n "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '  actual=$(sha256sum -- "$target" | cut -d " " -f 1)',
  '  [ "$actual" = "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '  mode=$(stat -c %a -- "$target")',
  "else",
  '  [ -z "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  "fi",
  'owner_pid=$PPID',
  'registry=$(mktemp -- "${TMPDIR:-/tmp}/codex-bridge-write-registry.$owner_pid.XXXXXX")',
  'suffix=${registry##*.}',
  'tmp="$parent/.codex-bridge-write.$owner_pid.$suffix"',
  'cleanup() { rm -f -- "$tmp" "$registry"; }',
  "trap cleanup EXIT HUP INT TERM",
  'printf "%s\\n%s\\n" "$(printf "%s" "$root" | base64 -w 0)" "$(printf "%s" "$tmp" | base64 -w 0)" >"$registry"',
  'chmod 600 -- "$registry"',
  '(umask 077; set -C; : >"$tmp") || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  'cat >"$tmp"',
  'size=$(wc -c <"$tmp" | tr -d "[:space:]")',
  '[ "$size" -le "$max_bytes" ] || { printf "%s\\n" "CODEX_BRIDGE:OUTPUT_TRUNCATED" >&2; exit 43; }',
  '[ "$size" -eq "$expected_bytes" ] || { printf "%s\\n" "CODEX_BRIDGE:PROTOCOL_MISMATCH" >&2; exit 45; }',
  'chmod "$mode" -- "$tmp"',
  'if [ "$exists" -eq 1 ]; then',
  '  actual=$(sha256sum -- "$target" | cut -d " " -f 1)',
  '  [ "$actual" = "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '  command -v sync >/dev/null 2>&1 && sync -f "$tmp" 2>/dev/null || true',
  '  mv -fT -- "$tmp" "$target"',
  "else",
  '  if ! ln -- "$tmp" "$target" 2>/dev/null; then',
  '    printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2',
  "    exit 40",
  "  fi",
  '  rm -f -- "$tmp"',
  "fi",
  'rm -f -- "$registry"',
  "trap - EXIT HUP INT TERM",
  'hash=$(sha256sum -- "$target" | cut -d " " -f 1)',
  'mode=$(stat -c %f -- "$target")',
  'modified=$(stat -c %Y -- "$target")',
  'printf "%s\\0%s\\0%s\\0%s\\0%s" "$target" "$size" "$mode" "$modified" "$hash"',
].join("\n");

const REMOTE_MKDIR_SCRIPT = [
  "set -eu",
  'root=$(realpath -e -- "$1")',
  'target=$2',
  'parent=$(realpath -e -- "$(dirname -- "$target")") || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'case "$parent" in "$root"|"$root"/*) ;; *) printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42 ;; esac',
  'target="$parent/$(basename -- "$target")"',
  '[ ! -L "$target" ] || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'if [ -e "$target" ]; then',
  '  [ -d "$target" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  "else",
  '  mkdir -- "$target" || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  "fi",
  'printf "%s" "$target"',
].join("\n");

const REMOTE_RENAME_SCRIPT = [
  "set -eu",
  'root=$(realpath -e -- "$1")',
  'source_lexical=$2',
  'destination=$3',
  'expected=$4',
  '[ ! -L "$source_lexical" ] || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'source=$(realpath -e -- "$source_lexical") || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'case "$source" in "$root"|"$root"/*) ;; *) printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42 ;; esac',
  '[ "$source" != "$root" ] || { printf "%s\\n" "CODEX_BRIDGE:COMMAND_DENIED" >&2; exit 44; }',
  'parent=$(realpath -e -- "$(dirname -- "$destination")") || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'case "$parent" in "$root"|"$root"/*) ;; *) printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42 ;; esac',
  'destination="$parent/$(basename -- "$destination")"',
  '[ ! -e "$destination" ] && [ ! -L "$destination" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  'if [ -f "$source" ]; then',
  '  [ -n "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '  actual=$(sha256sum -- "$source" | cut -d " " -f 1)',
  '  [ "$actual" = "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  "elif [ -d \"$source\" ]; then",
  '  [ -z "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:PROTOCOL_MISMATCH" >&2; exit 45; }',
  "else",
  '  printf "%s\\n" "CODEX_BRIDGE:COMMAND_DENIED" >&2',
  "  exit 44",
  "fi",
  'mv -nT -- "$source" "$destination" || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '[ ! -e "$source" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  'printf "%s\\0%s" "$source" "$destination"',
].join("\n");

const REMOTE_DELETE_SCRIPT = [
  "set -eu",
  'root=$(realpath -e -- "$1")',
  'source_lexical=$2',
  'expected=$3',
  '[ ! -L "$source_lexical" ] || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'source=$(realpath -e -- "$source_lexical") || { printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42; }',
  'case "$source" in "$root"|"$root"/*) ;; *) printf "%s\\n" "CODEX_BRIDGE:PATH_OUTSIDE_ROOT" >&2; exit 42 ;; esac',
  '[ "$source" != "$root" ] || { printf "%s\\n" "CODEX_BRIDGE:COMMAND_DENIED" >&2; exit 44; }',
  'if [ -f "$source" ]; then',
  '  [ -n "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '  actual=$(sha256sum -- "$source" | cut -d " " -f 1)',
  '  [ "$actual" = "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:FILE_CONFLICT" >&2; exit 40; }',
  '  rm -- "$source"',
  "elif [ -d \"$source\" ]; then",
  '  [ -z "$expected" ] || { printf "%s\\n" "CODEX_BRIDGE:PROTOCOL_MISMATCH" >&2; exit 45; }',
  '  rmdir -- "$source" || { printf "%s\\n" "CODEX_BRIDGE:COMMAND_DENIED" >&2; exit 44; }',
  "else",
  '  printf "%s\\n" "CODEX_BRIDGE:COMMAND_DENIED" >&2',
  "  exit 44",
  "fi",
].join("\n");

export function quotePosix(value: string): string {
  if (value.includes("\0")) {
    throw new BridgeError("COMMAND_DENIED", "Remote command arguments must not contain NUL");
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildRemoteCommand(cwd: string, argv: readonly string[]): string {
  if (argv.length === 0 || !argv[0]) {
    throw new BridgeError("COMMAND_DENIED", "Remote command argv must not be empty");
  }
  return [
    "sh",
    "-c",
    quotePosix(REMOTE_WRAPPER),
    "codex-bridge",
    quotePosix(cwd),
    ...argv.map(quotePosix),
  ].join(" ");
}

export function buildSshArgs(
  config: BridgeConfig,
  remoteCommand: string,
  controlPath?: string,
): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `ConnectTimeout=${config.connectTimeoutSeconds}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    ...(controlPath
      ? [
          "-o",
          "ControlMaster=auto",
          "-o",
          "ControlPersist=15",
          "-o",
          `ControlPath=${controlPath}`,
        ]
      : []),
    ...(config.sshPort ? ["-p", String(config.sshPort)] : []),
    ...(config.sshUser ? ["-l", config.sshUser] : []),
    ...(config.identityFile ? ["-i", config.identityFile] : []),
    "--",
    config.host,
    remoteCommand,
  ];
}

export function buildSshEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const allowedName =
    hostPlatform === "win32"
      ? /^(COMSPEC|HOME|HOMEDRIVE|HOMEPATH|LANG|LC_[A-Z0-9_]+|PATH|PATHEXT|SSH_AGENT_PID|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|SSH_AUTH_SOCK|SYSTEMROOT|TEMP|TMP|USERDOMAIN|USERNAME|USERPROFILE|WINDIR)$/i
      : /^(DISPLAY|HOME|LANG|LC_[A-Z0-9_]+|LOGNAME|PATH|SSH_AGENT_PID|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|SSH_AUTH_SOCK|TERM|USER|WAYLAND_DISPLAY|XDG_RUNTIME_DIR)$/;
  for (const [key, value] of Object.entries(environment)) {
    if (allowedName.test(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

class TailCapture {
  #buffer = Buffer.alloc(0);
  readonly #limit: number;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    if (chunk.length >= this.#limit) {
      this.#buffer = Buffer.from(chunk.subarray(chunk.length - this.#limit));
      this.truncated = true;
      return;
    }
    if (this.#buffer.length + chunk.length > this.#limit) {
      const overflow = this.#buffer.length + chunk.length - this.#limit;
      this.#buffer = Buffer.concat([this.#buffer.subarray(overflow), chunk]);
      this.truncated = true;
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
  }

  toString(): string {
    return this.#buffer.toString("utf8");
  }
}

export class OpenSshExecutor {
  readonly config: BridgeConfig;
  readonly connectionId = `conn_${randomUUID()}`;
  readonly #activeChildren = new Set<ChildProcessWithoutNullStreams>();
  readonly #controlDirectory: string | null;
  readonly #controlPath: string | null;
  readonly #spawnProcess: SpawnProcess;
  #closed = false;
  #usedControlPath = false;

  constructor(config: BridgeConfig, spawnProcess: SpawnProcess = spawn) {
    this.config = config;
    this.#spawnProcess = spawnProcess;
    if (spawnProcess === spawn && process.platform !== "win32") {
      this.#controlDirectory = mkdtempSync(join(tmpdir(), "codex-bridge-ssh-"));
      chmodSyncIfSupported(this.#controlDirectory, 0o700);
      this.#controlPath = join(this.#controlDirectory, "control.sock");
    } else {
      this.#controlDirectory = null;
      this.#controlPath = null;
    }
  }

  async execute(argv: readonly string[], options: ExecuteOptions = {}): Promise<RemoteCommandResult> {
    if (this.#closed) {
      throw new BridgeError("SSH_DISCONNECTED", "Remote executor is closed");
    }

    const cwd = normalizeRemotePath(
      this.config.workspaceRoot,
      options.cwd ?? this.config.workspaceRoot,
    ).absolutePath;
    const unsetEnvironment: string[] = [];
    const setEnvironment: string[] = [];
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new BridgeError("COMMAND_DENIED", `Invalid environment variable name: ${key}`);
      }
      if (value === null) {
        unsetEnvironment.push("-u", key);
      } else {
        setEnvironment.push(`${key}=${value}`);
      }
    }
    const commandArgv =
      unsetEnvironment.length > 0 || setEnvironment.length > 0
        ? ["env", ...unsetEnvironment, ...setEnvironment, ...argv]
        : [...argv];
    const remoteCommand = buildRemoteCommand(cwd, commandArgv);
    const sshArgs = buildSshArgs(this.config, remoteCommand, this.#controlPath ?? undefined);
    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? this.config.commandTimeoutMs;

    return await new Promise<RemoteCommandResult>((resolve, reject) => {
      const child = this.#spawnProcess(this.config.sshExecutable, sshArgs, {
        env: buildSshEnvironment(),
        stdio: "pipe",
      });
      this.#usedControlPath = Boolean(this.#controlPath);
      this.#activeChildren.add(child);

      const stdout = new TailCapture(this.config.maxOutputBytes);
      const stderr = new TailCapture(this.config.maxOutputBytes);
      let actualCwd = "";
      let stdoutHeader = Buffer.alloc(0);
      let headerParsed = false;
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        this.#activeChildren.delete(child);
        callback();
      };

      const terminate = (): void => {
        child.kill("SIGTERM");
        const forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceTimer.unref();
      };

      const abort = (): void => {
        aborted = true;
        terminate();
      };

      if (options.signal?.aborted) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref();
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          finish(() =>
            reject(
              new BridgeError(
                "SSH_DISCONNECTED",
                `Unable to stream OpenSSH stdin: ${error.message}`,
                undefined,
                { cause: error },
              ),
            ),
          );
        }
      });
      child.stdin.end(options.stdin);

      child.on("error", (error) => {
        finish(() =>
          reject(
            new BridgeError("SSH_DISCONNECTED", `Failed to start OpenSSH: ${error.message}`, undefined, {
              cause: error,
            }),
          ),
        );
      });

      child.stdout.on("data", (rawChunk: Buffer) => {
        let chunk = rawChunk;
        if (!headerParsed) {
          stdoutHeader = Buffer.concat([stdoutHeader, chunk]);
          const delimiter = stdoutHeader.indexOf(0);
          if (delimiter < 0) {
            if (stdoutHeader.length > 16 * 1024) {
              terminate();
              finish(() =>
                reject(
                  new BridgeError(
                    "PROTOCOL_MISMATCH",
                    "Remote command did not return its canonical working directory",
                  ),
                ),
              );
            }
            return;
          }
          actualCwd = stdoutHeader.subarray(0, delimiter).toString("utf8");
          chunk = stdoutHeader.subarray(delimiter + 1);
          stdoutHeader = Buffer.alloc(0);
          headerParsed = true;
        }
        if (chunk.length > 0) {
          stdout.append(chunk);
          options.onStdout?.(chunk.toString("utf8"));
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
        options.onStderr?.(chunk.toString("utf8"));
      });

      child.on("close", (exitCode, signal) => {
        finish(() => {
          const durationMs = Math.round(performance.now() - startedAt);
          if (timedOut) {
            reject(
              new BridgeError(
                options.sideEffect ? "RESULT_UNKNOWN" : "TIMEOUT",
                options.sideEffect
                  ? "SSH command timed out; the remote side effect may have completed"
                  : "SSH command timed out",
                { durationMs },
              ),
            );
            return;
          }
          if (aborted) {
            reject(
              new BridgeError(
                options.sideEffect ? "RESULT_UNKNOWN" : "CANCELLED",
                options.sideEffect
                  ? "SSH command was cancelled; the remote side effect is unknown"
                  : "SSH command was cancelled",
              ),
            );
            return;
          }
          const stderrText = stderr.toString();
          if (exitCode === 255) {
            if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderrText)) {
              reject(new BridgeError("HOST_KEY_MISMATCH", "SSH host key verification failed"));
            } else {
              reject(new BridgeError("SSH_DISCONNECTED", "OpenSSH connection failed", {
                stderr: stderrText,
              }));
            }
            return;
          }
          if (!headerParsed) {
            reject(
              new BridgeError(
                "SSH_DISCONNECTED",
                "Remote command exited before reporting its working directory",
                { exitCode, stderr: stderrText },
              ),
            );
            return;
          }
          resolve({
            actualCwd,
            durationMs,
            exitCode,
            signal,
            stderr: stderrText,
            stdout: stdout.toString(),
            truncated: stdout.truncated || stderr.truncated,
          });
        });
      });
    });
  }

  async startBackgroundTask(
    _taskId: string,
    _argv: readonly string[],
    _options: ExecuteOptions = {},
  ): Promise<RemoteBackgroundTaskSummary> {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Background tasks require the active VS Code Remote transport",
    );
  }

  async backgroundTaskStatus(
    _taskId: string,
  ): Promise<RemoteBackgroundTaskSummary> {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Background tasks require the active VS Code Remote transport",
    );
  }

  async readBackgroundTaskLog(
    _taskId: string,
    _cursor = 0,
    _limitBytes = 256 * 1024,
  ): Promise<RemoteBackgroundLogResult> {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Background tasks require the active VS Code Remote transport",
    );
  }

  async cancelBackgroundTask(
    _taskId: string,
  ): Promise<RemoteBackgroundTaskSummary> {
    throw new BridgeError(
      "COMMAND_DENIED",
      "Background tasks require the active VS Code Remote transport",
    );
  }

  async probe(): Promise<RemoteIdentity> {
    const script = [
      'root=$(realpath -e -- "$1")',
      'test -d "$root"',
      'printf "%s\\0" "$(hostname)"',
      'tr -d "\\n" </etc/machine-id',
      'printf "\\0%s" "$root"',
    ].join("\n");
    const result = await this.execute(
      ["sh", "-c", script, "codex-bridge-probe", this.config.workspaceRoot],
      { timeoutMs: Math.min(this.config.commandTimeoutMs, 30_000) },
    );
    if (result.exitCode !== 0) {
      throw new BridgeError("SSH_DISCONNECTED", "Remote workspace probe failed", {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    const [hostname, machineId, workspaceRoot] = result.stdout.split("\0");
    if (!hostname || !machineId || !workspaceRoot) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Remote identity probe returned invalid output");
    }
    return {
      hostId: this.config.host,
      hostname,
      machineId,
      workspaceRoot,
    };
  }

  async canonicalPath(inputPath: string): Promise<string> {
    const normalized = normalizeRemotePath(this.config.workspaceRoot, inputPath);
    const result = await this.execute(["realpath", "-e", "-z", "--", normalized.absolutePath]);
    if (result.exitCode !== 0) {
      throw new BridgeError("PATH_OUTSIDE_ROOT", "Remote path does not exist or cannot be resolved", {
        path: inputPath,
      });
    }
    const canonical = result.stdout.endsWith("\0")
      ? result.stdout.slice(0, -1)
      : result.stdout.replace(/\n$/, "");
    const rootResult = await this.execute(["realpath", "-e", "-z", "--", this.config.workspaceRoot]);
    const canonicalRoot = rootResult.stdout.endsWith("\0")
      ? rootResult.stdout.slice(0, -1)
      : rootResult.stdout.replace(/\n$/, "");
    if (
      rootResult.exitCode !== 0 ||
      !canonicalRoot ||
      !canonical ||
      !isPathInside(canonicalRoot, canonical)
    ) {
      throw new BridgeError("PATH_OUTSIDE_ROOT", "Resolved remote path escapes the workspace", {
        path: inputPath,
      });
    }
    return canonical;
  }

  async readFile(inputPath: string, limitBytes = this.config.maxOutputBytes / 2): Promise<RemoteFileRead> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const metadataResult = await this.execute([
      "stat",
      "-Lc",
      "%s\t%f\t%Y",
      "--",
      canonicalPath,
    ]);
    if (metadataResult.exitCode !== 0) {
      throw new BridgeError("SSH_DISCONNECTED", "Unable to read remote file metadata");
    }
    const [sizeText, mode = "", modifiedSeconds = "0"] = metadataResult.stdout.trim().split("\t");
    const size = Number.parseInt(sizeText ?? "", 10);
    if (!Number.isFinite(size)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Remote stat returned an invalid file size");
    }

    const hashResult = await this.execute(["sha256sum", "--", canonicalPath]);
    if (hashResult.exitCode !== 0) {
      throw new BridgeError("SSH_DISCONNECTED", "Unable to hash remote file");
    }
    const hash = hashResult.stdout.split(/\s+/, 1)[0] ?? "";

    const safeLimit = Math.max(1, Math.min(Math.floor(limitBytes), this.config.maxOutputBytes / 2));
    const readScript = 'head -c "$2" -- "$1" | base64 -w 0';
    const contentResult = await this.execute([
      "sh",
      "-c",
      readScript,
      "codex-bridge-read",
      canonicalPath,
      String(safeLimit),
    ]);
    if (contentResult.exitCode !== 0) {
      throw new BridgeError("SSH_DISCONNECTED", "Unable to read remote file", {
        stderr: contentResult.stderr,
      });
    }

    return {
      canonicalPath,
      contentBase64: contentResult.stdout,
      hash,
      mode,
      modifiedAtMs: Number.parseInt(modifiedSeconds, 10) * 1_000,
      size,
      truncated: size > safeLimit,
    };
  }

  async writeFile(
    inputPath: string,
    contentBase64: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const maxBytes = Math.min(
      MAX_WORKSPACE_WRITE_BYTES,
      Math.max(1, this.config.maxOutputBytes),
    );
    const content = decodeWorkspaceContent(contentBase64, maxBytes);
    const expectedHash = validateExpectedHash(options.expectedHash, false);
    const target = normalizeRemotePath(
      this.config.workspaceRoot,
      inputPath,
    ).absolutePath;
    const result = await this.execute(
      [
        "sh",
        "-c",
        REMOTE_WRITE_SCRIPT,
        "codex-bridge-write",
        this.config.workspaceRoot,
        target,
        expectedHash ?? "",
        String(maxBytes),
        String(content.length),
      ],
      {
        idempotencyKey: options.idempotencyKey,
        sideEffect: true,
        signal: options.signal,
        stdin: content,
      },
    );
    this.#assertMutationSucceeded(result, "write");
    const [canonicalPath, sizeText, mode, modifiedText, hash] =
      result.stdout.split("\0");
    const size = Number.parseInt(sizeText ?? "", 10);
    const modifiedSeconds = Number.parseInt(modifiedText ?? "", 10);
    if (
      !canonicalPath ||
      !mode ||
      !hash ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(modifiedSeconds)
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Workspace write returned invalid metadata",
      );
    }
    return {
      operation: "write",
      canonicalPath,
      bytesWritten: content.length,
      hash,
      mode,
      modifiedAtMs: modifiedSeconds * 1_000,
      size,
      ...(result.idempotencyOutcome
        ? { idempotencyOutcome: result.idempotencyOutcome }
        : {}),
    };
  }

  async applyPatch(
    inputPath: string,
    replacements: readonly WorkspacePatchReplacement[],
    options: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult> {
    const expectedHash = validateExpectedHash(options.expectedHash, true);
    const maxBytes = Math.min(
      MAX_WORKSPACE_WRITE_BYTES,
      Math.max(1, this.config.maxOutputBytes),
    );
    const current = await this.readFile(inputPath, maxBytes);
    if (current.truncated) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Workspace file exceeds the configured patch byte limit",
        { limitBytes: maxBytes, size: current.size },
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
    if (patched.length > maxBytes) {
      throw new BridgeError(
        "OUTPUT_TRUNCATED",
        "Patched workspace file exceeds the configured write byte limit",
        { limitBytes: maxBytes, size: patched.length },
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
    options: Omit<WorkspaceMutationOptions, "expectedHash"> = {},
  ): Promise<WorkspaceMutationResult> {
    const target = normalizeRemotePath(
      this.config.workspaceRoot,
      inputPath,
    ).absolutePath;
    const result = await this.execute(
      [
        "sh",
        "-c",
        REMOTE_MKDIR_SCRIPT,
        "codex-bridge-mkdir",
        this.config.workspaceRoot,
        target,
      ],
      {
        idempotencyKey: options.idempotencyKey,
        sideEffect: true,
        signal: options.signal,
      },
    );
    this.#assertMutationSucceeded(result, "mkdir");
    if (!result.stdout) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Workspace directory creation returned invalid metadata",
      );
    }
    return {
      operation: "mkdir",
      canonicalPath: result.stdout,
      bytesWritten: 0,
      ...(result.idempotencyOutcome
        ? { idempotencyOutcome: result.idempotencyOutcome }
        : {}),
    };
  }

  async renamePath(
    inputPath: string,
    destinationPath: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const source = normalizeRemotePath(
      this.config.workspaceRoot,
      inputPath,
    ).absolutePath;
    const destination = normalizeRemotePath(
      this.config.workspaceRoot,
      destinationPath,
    ).absolutePath;
    const result = await this.execute(
      [
        "sh",
        "-c",
        REMOTE_RENAME_SCRIPT,
        "codex-bridge-rename",
        this.config.workspaceRoot,
        source,
        destination,
        validateExpectedHash(options.expectedHash, false) ?? "",
      ],
      {
        idempotencyKey: options.idempotencyKey,
        sideEffect: true,
        signal: options.signal,
      },
    );
    this.#assertMutationSucceeded(result, "rename");
    const [canonicalPath, destinationCanonicalPath] = result.stdout.split("\0");
    if (!canonicalPath || !destinationCanonicalPath) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Workspace rename returned invalid metadata",
      );
    }
    return {
      operation: "rename",
      canonicalPath,
      destinationCanonicalPath,
      bytesWritten: 0,
      ...(result.idempotencyOutcome
        ? { idempotencyOutcome: result.idempotencyOutcome }
        : {}),
    };
  }

  async deletePath(
    inputPath: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const source = normalizeRemotePath(
      this.config.workspaceRoot,
      inputPath,
    ).absolutePath;
    const result = await this.execute(
      [
        "sh",
        "-c",
        REMOTE_DELETE_SCRIPT,
        "codex-bridge-delete",
        this.config.workspaceRoot,
        source,
        validateExpectedHash(options.expectedHash, false) ?? "",
      ],
      {
        idempotencyKey: options.idempotencyKey,
        sideEffect: true,
        signal: options.signal,
      },
    );
    this.#assertMutationSucceeded(result, "delete");
    return {
      operation: "delete",
      canonicalPath,
      bytesWritten: 0,
      ...(result.idempotencyOutcome
        ? { idempotencyOutcome: result.idempotencyOutcome }
        : {}),
    };
  }

  #assertMutationSucceeded(
    result: RemoteCommandResult,
    operation: string,
  ): void {
    if (result.exitCode === 0) {
      return;
    }
    const marker = /CODEX_BRIDGE:([A-Z_]+)/.exec(result.stderr)?.[1];
    switch (marker) {
      case "FILE_CONFLICT":
        throw new BridgeError(
          "FILE_CONFLICT",
          `Workspace ${operation} conflicted with the current filesystem state`,
        );
      case "PATH_OUTSIDE_ROOT":
        throw new BridgeError(
          "PATH_OUTSIDE_ROOT",
          `Workspace ${operation} path escapes the configured root`,
        );
      case "OUTPUT_TRUNCATED":
        throw new BridgeError(
          "OUTPUT_TRUNCATED",
          `Workspace ${operation} exceeded the configured byte limit`,
        );
      case "PROTOCOL_MISMATCH":
        throw new BridgeError(
          "PROTOCOL_MISMATCH",
          `Workspace ${operation} received incompatible arguments`,
        );
      default:
        throw new BridgeError(
          "COMMAND_DENIED",
          `Workspace ${operation} failed`,
          { exitCode: result.exitCode, stderr: result.stderr },
        );
    }
  }

  async listDirectory(inputPath: string): Promise<DirectoryEntry[]> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const script = [
      'find -P "$1" -mindepth 1 -maxdepth 1 -printf "%f\\0%y\\0"',
    ].join("\n");
    const result = await this.execute([
      "sh",
      "-c",
      script,
      "codex-bridge-list",
      canonicalPath,
    ]);
    if (result.truncated) {
      throw new BridgeError("OUTPUT_TRUNCATED", "Remote directory listing exceeded the output limit");
    }
    if (result.exitCode !== 0) {
      throw new BridgeError("SSH_DISCONNECTED", "Unable to list remote directory", {
        stderr: result.stderr,
      });
    }
    const fields = result.stdout.split("\0");
    const entries: DirectoryEntry[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const name = fields[index];
      const rawType = fields[index + 1];
      if (!name || !rawType) {
        continue;
      }
      const type =
        rawType === "d"
          ? "directory"
          : rawType === "f"
            ? "file"
            : rawType === "l"
              ? "symlink"
              : "other";
      entries.push({ name, type });
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async listTree(inputPath: string, depth = 2, maxEntries = 400): Promise<TreeListing> {
    const canonicalPath = await this.canonicalPath(inputPath);
    const safeDepth = Math.max(1, Math.min(Math.floor(depth), 4));
    const safeMaxEntries = Math.max(1, Math.min(Math.floor(maxEntries), 2_000));
    const fieldLimit = (safeMaxEntries + 1) * 2;
    const script =
      'find -P "$1" -mindepth 1 -maxdepth "$2" -printf "%P\\0%y\\0" | head -z -n "$3"';
    const result = await this.execute([
      "sh",
      "-c",
      script,
      "codex-bridge-tree",
      canonicalPath,
      String(safeDepth),
      String(fieldLimit),
    ]);
    if (result.truncated) {
      throw new BridgeError("OUTPUT_TRUNCATED", "Remote directory tree exceeded the output limit");
    }
    if (result.exitCode !== 0) {
      throw new BridgeError("SSH_DISCONNECTED", "Unable to inspect remote directory tree", {
        stderr: result.stderr,
      });
    }

    const fields = result.stdout.split("\0");
    const entries: TreeEntry[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const path = fields[index];
      const rawType = fields[index + 1];
      if (!path || !rawType) {
        continue;
      }
      const type =
        rawType === "d"
          ? "directory"
          : rawType === "f"
            ? "file"
            : rawType === "l"
              ? "symlink"
              : "other";
      entries.push({ path, type });
    }
    const truncated = entries.length > safeMaxEntries;
    return {
      entries: entries.slice(0, safeMaxEntries),
      truncated,
    };
  }

  async search(
    query: string,
    inputPaths: readonly string[] = ["."],
    maxResults = 200,
  ): Promise<SearchMatch[]> {
    if (!query || query.includes("\0")) {
      throw new BridgeError("COMMAND_DENIED", "Search query must be a non-empty NUL-free string");
    }
    const canonicalPaths: string[] = [];
    for (const inputPath of inputPaths.length > 0 ? inputPaths : ["."]) {
      const canonical = await this.canonicalPath(inputPath);
      canonicalPaths.push(canonical);
    }
    const result = await this.execute([
      "rg",
      "--json",
      "--fixed-strings",
      "--max-count",
      String(Math.max(1, Math.min(maxResults, 5_000))),
      "--",
      query,
      ...canonicalPaths,
    ]);
    if (result.exitCode === 127) {
      return await this.#searchWithGrep(query, canonicalPaths, maxResults);
    }
    if (result.truncated) {
      throw new BridgeError("OUTPUT_TRUNCATED", "Remote search exceeded the output limit");
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new BridgeError("COMMAND_DENIED", "Remote search failed", {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
    const matches: SearchMatch[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line) {
        continue;
      }
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          line_number?: number;
          lines?: { text?: string };
          path?: { text?: string };
        };
      };
      if (event.type === "match" && event.data?.path?.text && event.data.line_number) {
        matches.push({
          path: event.data.path.text,
          lineNumber: event.data.line_number,
          lines: event.data.lines?.text ?? "",
        });
        if (matches.length >= maxResults) {
          break;
        }
      }
    }
    return matches;
  }

  async gitStatus(): Promise<RemoteCommandResult> {
    return await this.execute([
      "git",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--short",
      "--branch",
    ]);
  }

  async #searchWithGrep(
    query: string,
    canonicalPaths: readonly string[],
    maxResults: number,
  ): Promise<SearchMatch[]> {
    const result = await this.execute([
      "grep",
      "-rInZH",
      "--binary-files=without-match",
      "--exclude-dir=.git",
      "--max-count",
      String(Math.max(1, Math.min(maxResults, 5_000))),
      "-F",
      "--",
      query,
      ...canonicalPaths,
    ]);
    if (result.truncated) {
      throw new BridgeError("OUTPUT_TRUNCATED", "Remote grep search exceeded the output limit");
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new BridgeError("COMMAND_DENIED", "Remote grep search failed", {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    const matches: SearchMatch[] = [];
    let cursor = 0;
    while (cursor < result.stdout.length && matches.length < maxResults) {
      const pathEnd = result.stdout.indexOf("\0", cursor);
      if (pathEnd < 0) {
        break;
      }
      const lineEnd = result.stdout.indexOf("\n", pathEnd + 1);
      const payloadEnd = lineEnd < 0 ? result.stdout.length : lineEnd;
      const payload = result.stdout.slice(pathEnd + 1, payloadEnd);
      const separator = payload.indexOf(":");
      const lineNumber = Number.parseInt(payload.slice(0, separator), 10);
      if (separator > 0 && Number.isFinite(lineNumber)) {
        matches.push({
          path: result.stdout.slice(cursor, pathEnd),
          lineNumber,
          lines: payload.slice(separator + 1),
        });
      }
      cursor = payloadEnd + 1;
    }
    return matches;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const child of this.#activeChildren) {
      child.kill("SIGTERM");
    }
    this.#activeChildren.clear();
    if (this.#usedControlPath && this.#controlPath) {
      spawnSync(
        this.config.sshExecutable,
        [
          "-S",
          this.#controlPath,
          "-O",
          "exit",
          ...(this.config.sshPort ? ["-p", String(this.config.sshPort)] : []),
          ...(this.config.sshUser ? ["-l", this.config.sshUser] : []),
          ...(this.config.identityFile ? ["-i", this.config.identityFile] : []),
          "--",
          this.config.host,
        ],
        {
          env: buildSshEnvironment(),
          stdio: "ignore",
          timeout: 5_000,
        },
      );
    }
    if (this.#controlDirectory) {
      rmSync(this.#controlDirectory, { force: true, recursive: true });
    }
  }
}
