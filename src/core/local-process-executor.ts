import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { BridgeError } from "./errors.js";
import { isPathInside, normalizeRemotePath } from "./path-policy.js";
import {
  OpenSshExecutor,
  type ExecuteOptions,
  type SpawnProcess,
} from "./ssh-executor.js";
import type { BridgeConfig, RemoteCommandResult } from "./types.js";

const unreachableSpawn: SpawnProcess = (
  _command: string,
  _args: readonly string[],
  _options: SpawnOptionsWithoutStdio,
) => {
  throw new Error("The local process executor does not use the OpenSSH spawn path");
};

class TailCapture {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 0) {
      const removed = this.#chunks.shift();
      if (removed) {
        this.#size -= removed.length;
        this.truncated = true;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

export function remoteProcessEnvironment(
  changes: Record<string, string | null> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const sensitive =
    /^(VSCODE_|ELECTRON_|OPENAI_|CODEX_|CHATGPT_|GITHUB_TOKEN$|GH_TOKEN$|AZURE_.*(?:TOKEN|SECRET|KEY))/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (!sensitive.test(key)) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new BridgeError("COMMAND_DENIED", `Invalid environment variable name: ${key}`);
    }
    if (value === null) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

export function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  knownDescendants: readonly number[] = [],
): number[] {
  if (process.platform !== "win32" && child.pid) {
    const descendants =
      process.platform === "linux"
        ? collectLinuxDescendants(child.pid)
        : [];
    const targets = [...new Set([...descendants, ...knownDescendants])];
    for (const pid of targets) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.kill(signal);
        }
      }
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
      }
    }
    return targets;
  }
  child.kill(signal);
  return [];
}

function collectLinuxDescendants(rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^PPid:\s+(\d+)$/m.exec(status);
      if (!match) {
        continue;
      }
      const parentPid = Number.parseInt(match[1]!, 10);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
    } catch {
      // Processes may exit while /proc is being scanned.
    }
  }

  const descendants: number[] = [];
  const visit = (pid: number): void => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

export class LocalProcessExecutor extends OpenSshExecutor {
  readonly #activeCancellations = new Set<() => void>();
  #closed = false;

  constructor(config: BridgeConfig) {
    super(config, unreachableSpawn);
  }

  override async execute(
    argv: readonly string[],
    options: ExecuteOptions = {},
  ): Promise<RemoteCommandResult> {
    if (this.#closed) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "VS Code remote executor is closed",
      );
    }
    if (!argv[0]) {
      throw new BridgeError("COMMAND_DENIED", "Remote command argv must not be empty");
    }

    const lexicalCwd = normalizeRemotePath(
      this.config.workspaceRoot,
      options.cwd ?? this.config.workspaceRoot,
    ).absolutePath;
    let canonicalRoot: string;
    let actualCwd: string;
    try {
      [canonicalRoot, actualCwd] = await Promise.all([
        realpath(this.config.workspaceRoot),
        realpath(lexicalCwd),
      ]);
    } catch (error) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Remote command working directory does not exist",
        { cwd: lexicalCwd },
        { cause: error },
      );
    }
    if (!isPathInside(canonicalRoot, actualCwd)) {
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Resolved remote command working directory escapes the workspace",
        { cwd: lexicalCwd },
      );
    }

    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? this.config.commandTimeoutMs;
    return await new Promise<RemoteCommandResult>((resolve, reject) => {
      const child = spawn("sh", ["-c", 'exec "$@"', "codex-bridge", ...argv], {
        cwd: actualCwd,
        detached: process.platform !== "win32",
        env: remoteProcessEnvironment(options.env),
        stdio: "pipe",
      });
      const stdout = new TailCapture(this.config.maxOutputBytes);
      const stderr = new TailCapture(this.config.maxOutputBytes);
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let terminating = false;
      let descendantPids: number[] = [];
      let forceTimer: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (forceTimer) {
          clearTimeout(forceTimer);
        }
        options.signal?.removeEventListener("abort", abort);
        this.#activeCancellations.delete(abort);
        callback();
      };
      const terminate = (): void => {
        if (terminating) {
          return;
        }
        terminating = true;
        descendantPids = signalProcessTree(child, "SIGTERM", descendantPids);
        forceTimer = setTimeout(() => {
          if (!settled) {
            descendantPids = signalProcessTree(child, "SIGKILL", descendantPids);
          }
        }, 1_000);
        forceTimer.unref();
      };
      const abort = (): void => {
        if (aborted || settled) {
          return;
        }
        aborted = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        terminate();
      };
      this.#activeCancellations.add(abort);
      timeout = setTimeout(() => {
        if (aborted || settled) {
          return;
        }
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref();
      if (options.signal?.aborted) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          finish(() =>
            reject(
              new BridgeError(
                "REMOTE_TRANSPORT_DISCONNECTED",
                `Unable to stream remote command stdin: ${error.message}`,
                undefined,
                { cause: error },
              ),
            ),
          );
        }
      });
      child.stdin.end(options.stdin);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
        options.onStdout?.(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
        options.onStderr?.(chunk.toString("utf8"));
      });
      child.once("error", (error) => {
        finish(() =>
          reject(
            new BridgeError(
              "REMOTE_TRANSPORT_DISCONNECTED",
              `Failed to start remote command: ${error.message}`,
              undefined,
              { cause: error },
            ),
          ),
        );
      });
      child.once("close", (exitCode, signal) => {
        if (terminating && process.platform !== "win32") {
          descendantPids = signalProcessTree(child, "SIGKILL", descendantPids);
        }
        finish(() => {
          const durationMs = Math.round(performance.now() - startedAt);
          if (timedOut) {
            reject(
              new BridgeError(
                options.sideEffect ? "RESULT_UNKNOWN" : "TIMEOUT",
                options.sideEffect
                  ? "Remote command timed out; the side effect may have completed"
                  : "Remote command timed out",
                { durationMs },
              ),
            );
            return;
          }
          if (aborted) {
            reject(
              new BridgeError(
                "CANCELLED",
                options.sideEffect
                  ? "Remote command and its process tree were cancelled; partial side effects may have occurred"
                  : "Remote command and its process tree were cancelled",
                {
                  durationMs,
                  sideEffectMayHaveOccurred: options.sideEffect === true,
                },
              ),
            );
            return;
          }
          resolve({
            actualCwd,
            durationMs,
            exitCode,
            signal,
            stderr: stderr.toString(),
            stdout: stdout.toString(),
            truncated: stdout.truncated || stderr.truncated,
          });
        });
      });
    });
  }

  override close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const cancel of this.#activeCancellations) {
      cancel();
    }
    this.#activeCancellations.clear();
    super.close();
  }
}
