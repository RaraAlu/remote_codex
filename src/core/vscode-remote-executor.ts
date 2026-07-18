import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { BridgeError } from "./errors.js";
import {
  OpenSshExecutor,
  type DirectoryEntry,
  type ExecuteOptions,
  type SearchMatch,
  type SpawnProcess,
  type TreeListing,
} from "./ssh-executor.js";
import {
  BRIDGE_ERROR_CODES,
  type BridgeConfig,
  type BridgeErrorCode,
  type RemoteCommandResult,
  type RemoteFileRead,
  type RemoteIdentity,
} from "./types.js";
import {
  REMOTE_OUTPUT_COMMAND,
  type RemoteExecutorOperation,
  type TransportMessage,
  type TransportRequest,
} from "./vscode-transport.js";

const unreachableSpawn: SpawnProcess = (
  _command: string,
  _args: readonly string[],
  _options: SpawnOptionsWithoutStdio,
) => {
  throw new Error("The VS Code remote executor does not use the OpenSSH spawn path");
};

interface RequestObserver {
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  sideEffect?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function errorCode(value: string): BridgeErrorCode {
  return BRIDGE_ERROR_CODES.includes(value as BridgeErrorCode)
    ? (value as BridgeErrorCode)
    : "REMOTE_TRANSPORT_DISCONNECTED";
}

export class VsCodeRemoteExecutor extends OpenSshExecutor {
  readonly #activeSockets = new Set<Socket>();
  #closed = false;

  constructor(config: BridgeConfig) {
    super(config, unreachableSpawn);
    if (config.connectionMode !== "vscode-remote" || !config.vscodeTransport) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "VS Code remote execution requires a window-scoped transport descriptor",
      );
    }
  }

  override async execute(
    argv: readonly string[],
    options: ExecuteOptions = {},
  ): Promise<RemoteCommandResult> {
    return await this.#request<RemoteCommandResult>(
      "execute",
      {
        argv: [...argv],
        options: {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          sideEffect: options.sideEffect === true,
        },
      },
      options,
    );
  }

  override async probe(): Promise<RemoteIdentity> {
    return await this.#request<RemoteIdentity>("probe", {});
  }

  override async canonicalPath(inputPath: string): Promise<string> {
    return await this.#request<string>("canonicalPath", { path: inputPath });
  }

  override async readFile(
    inputPath: string,
    limitBytes = this.config.maxOutputBytes / 2,
  ): Promise<RemoteFileRead> {
    return await this.#request<RemoteFileRead>("readFile", {
      limitBytes,
      path: inputPath,
    });
  }

  override async listDirectory(inputPath: string): Promise<DirectoryEntry[]> {
    return await this.#request<DirectoryEntry[]>("listDirectory", { path: inputPath });
  }

  override async listTree(
    inputPath: string,
    depth = 2,
    maxEntries = 400,
  ): Promise<TreeListing> {
    return await this.#request<TreeListing>("listTree", {
      depth,
      maxEntries,
      path: inputPath,
    });
  }

  override async search(
    query: string,
    inputPaths: readonly string[] = ["."],
    maxResults = 200,
  ): Promise<SearchMatch[]> {
    return await this.#request<SearchMatch[]>("search", {
      maxResults,
      paths: [...inputPaths],
      query,
    });
  }

  override close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const socket of this.#activeSockets) {
      socket.destroy();
    }
    this.#activeSockets.clear();
    super.close();
  }

  async #request<T>(
    operation: RemoteExecutorOperation,
    params: Record<string, unknown>,
    observer: RequestObserver = {},
  ): Promise<T> {
    if (this.#closed) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "VS Code remote executor is closed",
      );
    }
    const descriptor = this.config.vscodeTransport;
    if (!descriptor) {
      throw new BridgeError("INVALID_CONFIG", "VS Code transport descriptor is missing");
    }
    if (observer.signal?.aborted) {
      throw new BridgeError(
        observer.sideEffect ? "RESULT_UNKNOWN" : "CANCELLED",
        "VS Code remote request was cancelled before it started",
      );
    }
    const id = `vscode_${randomUUID()}`;
    const request: TransportRequest = {
      hostId: this.config.host,
      id,
      operation,
      outputCommand: REMOTE_OUTPUT_COMMAND,
      params,
      policy: {
        commandTimeoutMs: this.config.commandTimeoutMs,
        maxOutputBytes: this.config.maxOutputBytes,
      },
      token: descriptor.token,
      workspaceRoot: this.config.workspaceRoot,
    };

    return await new Promise<T>((resolve, reject) => {
      const socket = createConnection(descriptor.endpoint);
      this.#activeSockets.add(socket);
      const lines = createInterface({ input: socket });
      let settled = false;
      const timeoutMs = (observer.timeoutMs ?? this.config.commandTimeoutMs) + 5_000;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        observer.signal?.removeEventListener("abort", abort);
        lines.close();
        this.#activeSockets.delete(socket);
        socket.destroy();
        callback();
      };
      const disconnectError = (message: string): BridgeError =>
        new BridgeError(
          observer.sideEffect ? "RESULT_UNKNOWN" : "REMOTE_TRANSPORT_DISCONNECTED",
          observer.sideEffect
            ? `${message}; the remote side effect is unknown`
            : message,
        );
      const abort = (): void => {
        finish(() =>
          reject(
            new BridgeError(
              observer.sideEffect ? "RESULT_UNKNOWN" : "CANCELLED",
              observer.sideEffect
                ? "VS Code remote request was cancelled; the side effect is unknown"
                : "VS Code remote request was cancelled",
            ),
          ),
        );
      };
      const timeout = setTimeout(() => {
        finish(() => reject(disconnectError("VS Code remote transport timed out")));
      }, timeoutMs);
      timeout.unref();
      observer.signal?.addEventListener("abort", abort, { once: true });

      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.once("error", (error) => {
        finish(() =>
          reject(
            disconnectError(`Unable to connect to the VS Code remote transport: ${error.message}`),
          ),
        );
      });
      socket.once("end", () => {
        finish(() => reject(disconnectError("VS Code remote transport closed unexpectedly")));
      });
      lines.on("line", (line) => {
        let message: TransportMessage;
        try {
          message = JSON.parse(line) as TransportMessage;
        } catch (error) {
          finish(() =>
            reject(
              new BridgeError(
                "PROTOCOL_MISMATCH",
                "VS Code remote transport returned invalid JSON",
                undefined,
                { cause: error },
              ),
            ),
          );
          return;
        }
        if (message.id !== id) {
          finish(() =>
            reject(
              new BridgeError(
                "PROTOCOL_MISMATCH",
                "VS Code remote transport returned a mismatched request id",
              ),
            ),
          );
          return;
        }
        if (message.type === "output") {
          if (message.channel === "stdout") {
            observer.onStdout?.(message.chunk);
          } else {
            observer.onStderr?.(message.chunk);
          }
          return;
        }
        if (message.error) {
          finish(() =>
            reject(
              new BridgeError(
                errorCode(message.error?.code ?? ""),
                message.error?.message ?? "VS Code remote execution failed",
                message.error?.details,
              ),
            ),
          );
          return;
        }
        finish(() => resolve(message.result as T));
      });
    });
  }
}
