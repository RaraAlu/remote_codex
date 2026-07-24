import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { asBridgeError, BridgeError } from "./errors.js";
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
  type RemoteBackgroundLogResult,
  type RemoteBackgroundTaskSummary,
  type RemoteCommandResult,
  type RemoteFileRead,
  type RemoteIdentity,
} from "./types.js";
import {
  REMOTE_OUTPUT_COMMAND,
  type ControllerWorkspaceClient,
  type ControllerWorkspaceOperation,
  type RemoteExecutorOperation,
  type RemoteOperationSnapshot,
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
  timeoutGraceMs?: number;
  timeoutMs?: number;
}

interface RemoteCancellationResult {
  cancelled: boolean;
  operationId: string;
}

const RESULT_RECOVERY_POLL_MS = 100;
const RESULT_RECOVERY_TIMEOUT_MS = 3_000;
const RESULT_STATUS_TIMEOUT_MS = 1_000;

function errorCode(value: string): BridgeErrorCode {
  return BRIDGE_ERROR_CODES.includes(value as BridgeErrorCode)
    ? (value as BridgeErrorCode)
    : "REMOTE_TRANSPORT_DISCONNECTED";
}

export class VsCodeRemoteExecutor
  extends OpenSshExecutor
  implements ControllerWorkspaceClient
{
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
    const idempotencyKey = options.idempotencyKey ?? `exec_${randomUUID()}`;
    try {
      return await this.#request<RemoteCommandResult>(
        "execute",
        {
          argv: [...argv],
          idempotencyKey,
          options: {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.env ? { env: options.env } : {}),
            ...(options.stdin
              ? { stdinBase64: options.stdin.toString("base64") }
              : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            sideEffect: options.sideEffect === true,
          },
        },
        options,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "RESULT_UNKNOWN");
      if (!options.sideEffect || bridgeError.code !== "RESULT_UNKNOWN") {
        throw bridgeError;
      }
      return await this.#recoverExecuteResult(idempotencyKey, bridgeError);
    }
  }

  override async startBackgroundTask(
    taskId: string,
    argv: readonly string[],
    options: ExecuteOptions = {},
  ): Promise<RemoteBackgroundTaskSummary> {
    try {
      return await this.#request<RemoteBackgroundTaskSummary>(
        "backgroundStart",
        {
          argv: [...argv],
          taskId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        },
        { sideEffect: true, signal: options.signal },
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "RESULT_UNKNOWN");
      if (bridgeError.code !== "RESULT_UNKNOWN") {
        throw bridgeError;
      }
      try {
        const status = await this.backgroundTaskStatus(taskId);
        if (status.status !== "unknown") {
          return { ...status, idempotencyOutcome: "replayed" };
        }
      } catch {
        // Preserve the original unknown start result below.
      }
      throw new BridgeError(
        "RESULT_UNKNOWN",
        "Background task start could not be confirmed after transport disconnect",
        { cause: bridgeError.message, taskId },
      );
    }
  }

  override async backgroundTaskStatus(
    taskId: string,
  ): Promise<RemoteBackgroundTaskSummary> {
    return await this.#request<RemoteBackgroundTaskSummary>(
      "backgroundStatus",
      { taskId },
    );
  }

  override async readBackgroundTaskLog(
    taskId: string,
    cursor = 0,
    limitBytes = 256 * 1024,
  ): Promise<RemoteBackgroundLogResult> {
    return await this.#request<RemoteBackgroundLogResult>("backgroundLog", {
      cursor,
      limitBytes,
      taskId,
    });
  }

  override async cancelBackgroundTask(
    taskId: string,
  ): Promise<RemoteBackgroundTaskSummary> {
    return await this.#request<RemoteBackgroundTaskSummary>(
      "backgroundCancel",
      { taskId },
      { sideEffect: true },
    );
  }

  async operationStatus(
    idempotencyKey: string,
  ): Promise<RemoteOperationSnapshot<RemoteCommandResult>> {
    return await this.#request<RemoteOperationSnapshot<RemoteCommandResult>>(
      "resultStatus",
      { idempotencyKey },
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

  async requestControllerWorkspace<T>(
    operation: ControllerWorkspaceOperation,
    rootId: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return await this.#request<T>(operation, { ...params, rootId });
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

  async #recoverExecuteResult(
    idempotencyKey: string,
    originalError: BridgeError,
  ): Promise<RemoteCommandResult> {
    const deadline = Date.now() + RESULT_RECOVERY_TIMEOUT_MS;
    let attempts = 0;
    let lastStatus: RemoteOperationSnapshot["status"] | "unreachable" =
      "unreachable";
    let statusError: BridgeError | undefined;

    while (!this.#closed && Date.now() < deadline) {
      attempts += 1;
      let snapshot: RemoteOperationSnapshot<RemoteCommandResult>;
      try {
        snapshot = await this.#request<
          RemoteOperationSnapshot<RemoteCommandResult>
        >(
          "resultStatus",
          { idempotencyKey },
          {
            timeoutGraceMs: 0,
            timeoutMs: RESULT_STATUS_TIMEOUT_MS,
          },
        );
        statusError = undefined;
      } catch (error) {
        lastStatus = "unreachable";
        statusError = asBridgeError(error, "REMOTE_TRANSPORT_DISCONNECTED");
        if (!statusError.retryable) {
          break;
        }
        await this.#waitForRecoveryPoll(deadline);
        continue;
      }

      lastStatus = snapshot.status;
      if (snapshot.status === "completed") {
        if (
          !snapshot.result ||
          typeof snapshot.result !== "object" ||
          Array.isArray(snapshot.result)
        ) {
          break;
        }
        return {
          ...snapshot.result,
          idempotencyOutcome: "replayed",
        };
      }
      if (snapshot.status === "cancelled" || snapshot.status === "failed") {
        if (!snapshot.error) {
          break;
        }
        throw new BridgeError(
          errorCode(snapshot.error.code),
          snapshot.error.message,
          {
            ...snapshot.error.details,
            idempotencyOutcome: "replayed",
            recoveryAttempts: attempts,
          },
        );
      }
      if (snapshot.status === "unknown") {
        throw new BridgeError(
          "RESULT_UNKNOWN",
          snapshot.error?.message ??
            "Remote operation is absent from the current result ledger",
          {
            ...snapshot.error?.details,
            idempotencyKey,
            recoveryAttempts: attempts,
            recoveryStatus: "unknown",
          },
        );
      }
      if (snapshot.status !== "running") {
        break;
      }
      await this.#waitForRecoveryPoll(deadline);
    }

    throw new BridgeError(
      "RESULT_UNKNOWN",
      "Remote operation result could not be confirmed after the transport disconnected",
      {
        cause: originalError.message,
        idempotencyKey,
        lastStatus,
        recoveryAttempts: attempts,
        ...(statusError ? { statusError: statusError.message } : {}),
      },
    );
  }

  async #waitForRecoveryPoll(deadline: number): Promise<void> {
    const delayMs = Math.min(
      RESULT_RECOVERY_POLL_MS,
      Math.max(0, deadline - Date.now()),
    );
    if (delayMs === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref();
    });
  }

  async #request<T>(
    operation: ControllerWorkspaceOperation | RemoteExecutorOperation,
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
        "CANCELLED",
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
      let requestSent = false;
      let cancellationStarted = false;
      const timeoutMs =
        (observer.timeoutMs ?? this.config.commandTimeoutMs) +
        (observer.timeoutGraceMs ?? 5_000);
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
        if (settled || cancellationStarted) {
          return;
        }
        if (!requestSent) {
          finish(() =>
            reject(
              new BridgeError(
                "CANCELLED",
                "VS Code remote request was cancelled before it was sent",
              ),
            ),
          );
          return;
        }
        cancellationStarted = true;
        void this.#request<RemoteCancellationResult>(
          "cancel",
          { operationId: id },
          { timeoutMs: 5_000 },
        ).catch((error) => {
          finish(() =>
            reject(
              new BridgeError(
                observer.sideEffect ? "RESULT_UNKNOWN" : "REMOTE_TRANSPORT_DISCONNECTED",
                "VS Code remote cancellation could not be confirmed",
                {
                  cause: error instanceof Error ? error.message : String(error),
                  operationId: id,
                },
              ),
            ),
          );
        });
      };
      const timeout = setTimeout(() => {
        finish(() => reject(disconnectError("VS Code remote transport timed out")));
      }, timeoutMs);
      timeout.unref();
      observer.signal?.addEventListener("abort", abort, { once: true });

      socket.once("connect", () => {
        if (settled) {
          return;
        }
        requestSent = true;
        socket.write(`${JSON.stringify(request)}\n`);
      });
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
        if (message.type !== "response") {
          finish(() =>
            reject(
              new BridgeError(
                "PROTOCOL_MISMATCH",
                "VS Code remote transport returned an unexpected stream frame",
              ),
            ),
          );
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
