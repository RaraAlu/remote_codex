import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { defaultRemotePrimaryRoot, parseBridgeConfig } from "../core/config.js";
import { asBridgeError, BridgeError } from "../core/errors.js";
import { LocalProcessExecutor } from "../core/local-process-executor.js";
import {
  OperationLedger,
  type IdempotencyOutcome,
} from "../core/operation-ledger.js";
import type { ExecuteOptions } from "../core/ssh-executor.js";
import type { BridgeConfig } from "../core/types.js";
import { decodeWorkspaceContent } from "../core/workspace-mutations.js";
import {
  REMOTE_EXECUTOR_CAPABILITIES,
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_EXECUTOR_PING_COMMAND,
  REMOTE_EXECUTOR_PROTOCOL_VERSION,
  REMOTE_EXECUTOR_VERSION,
  REMOTE_OUTPUT_COMMAND,
  REMOTE_STDIO_MAX_FRAME_BYTES,
  type RemoteExecutorCommandRequest,
  type RemoteExecutorCommandResponse,
  type RemoteOutputEvent,
} from "../core/vscode-transport.js";
import { matchesRemoteWorkspaceRoot } from "./workspace.js";
import {
  BACKGROUND_TASK_MAX_LOG_READ_BYTES,
  RemoteBackgroundTasks,
} from "./background-tasks.js";
import { RemoteStdioSessions } from "./stdio-sessions.js";

const executors = new Map<string, LocalProcessExecutor>();
const operationLedger = new OperationLedger();
const backgroundTasks = new RemoteBackgroundTasks();
const stdioSessions = new RemoteStdioSessions(async (event) => {
  await vscode.commands.executeCommand(REMOTE_OUTPUT_COMMAND, event);
});

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("PROTOCOL_MISMATCH", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new BridgeError("PROTOCOL_MISMATCH", `${name} must be a string`);
  }
  return value;
}

function idempotencyKeyValue(value: unknown): string {
  const key = stringValue(value, "params.idempotencyKey");
  if (key.length === 0 || key.length > 256 || key.includes("\0")) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "params.idempotencyKey must contain 1 to 256 NUL-free characters",
    );
  }
  return key;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function operationFingerprint(request: RemoteExecutorCommandRequest): string {
  const { idempotencyKey: _idempotencyKey, ...params } = request.params;
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue({ params, policy: request.policy })))
    .digest("hex");
}

function resultWithIdempotencyOutcome(
  result: unknown,
  outcome: IdempotencyOutcome,
): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), idempotencyOutcome: outcome };
  }
  return { idempotencyOutcome: outcome, value: result };
}

function errorWithIdempotencyOutcome(
  error: unknown,
  outcome: IdempotencyOutcome,
) {
  const payload = asBridgeError(error, "REMOTE_TRANSPORT_DISCONNECTED").toPayload();
  return {
    ...payload,
    details: {
      ...payload.details,
      idempotencyOutcome: outcome,
    },
  };
}

function numberValue(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BridgeError("PROTOCOL_MISMATCH", `${name} must be an integer`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new BridgeError("PROTOCOL_MISMATCH", `${name} must be a string array`);
  }
  return value as string[];
}

function environmentValue(
  value: unknown,
  name: string,
): Record<string, string | null> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const environment = record(value, name);
  for (const [key, entry] of Object.entries(environment)) {
    if (typeof entry !== "string" && entry !== null) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        `${name}.${key} must be a string or null`,
      );
    }
  }
  return environment as Record<string, string | null>;
}

function validateWorkspace(request: RemoteExecutorCommandRequest): void {
  if (vscode.env.remoteName !== "ssh-remote") {
    throw new BridgeError(
      "REMOTE_TRANSPORT_DISCONNECTED",
      "Codex Bridge executor is not running in a Remote SSH extension host",
    );
  }
  const matches = vscode.workspace.workspaceFolders?.some(
    (folder) => matchesRemoteWorkspaceRoot(folder.uri, request.workspaceRoot),
  );
  if (!matches) {
    throw new BridgeError(
      "PATH_OUTSIDE_ROOT",
      "Executor request does not match an open Remote SSH workspace root",
      { workspaceRoot: request.workspaceRoot },
    );
  }
}

function executorFor(request: RemoteExecutorCommandRequest): LocalProcessExecutor {
  validateWorkspace(request);
  const key = `${request.hostId}\0${request.workspaceRoot}`;
  const existing = executors.get(key);
  if (existing) {
    return existing;
  }
  const config: BridgeConfig = parseBridgeConfig({
    version: 2,
    host: request.hostId,
    workspaceRoot: request.workspaceRoot,
    roots: [defaultRemotePrimaryRoot(request.workspaceRoot)],
    connectionMode: "vscode-remote",
    localExecution: "deny",
    remoteHelper: "vscode-extension",
    sshExecutable: "ssh",
    remoteMcpRouting: "local",
    remoteMcpAccess: "enabled",
    commandTimeoutMs: request.policy.commandTimeoutMs,
    maxOutputBytes: request.policy.maxOutputBytes,
    maxParallelReads: 8,
    maxParallelWrites: 1,
    connectTimeoutSeconds: 10,
  });
  const executor = new LocalProcessExecutor(config);
  executors.set(key, executor);
  return executor;
}

async function dispatch(
  request: RemoteExecutorCommandRequest,
  executor: LocalProcessExecutor,
  signal?: AbortSignal,
): Promise<unknown> {
  const params = record(request.params, "params");
  switch (request.operation) {
    case "backgroundStart": {
      const environment = environmentValue(params.env, "params.env");
      return await backgroundTasks.start({
        argv: stringArray(params.argv, "params.argv"),
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
        ...(environment ? { env: environment } : {}),
        taskId: stringValue(params.taskId, "params.taskId"),
        ...(typeof params.timeoutMs === "number"
          ? {
              timeoutMs: numberValue(
                params.timeoutMs,
                60 * 60_000,
                "params.timeoutMs",
              ),
            }
          : {}),
        workspaceRoot: request.workspaceRoot,
      });
    }
    case "backgroundStatus":
      return backgroundTasks.status(
        request.workspaceRoot,
        stringValue(params.taskId, "params.taskId"),
      );
    case "backgroundLog":
      return backgroundTasks.log(
        request.workspaceRoot,
        stringValue(params.taskId, "params.taskId"),
        numberValue(params.cursor, 0, "params.cursor"),
        numberValue(
          params.limitBytes,
          BACKGROUND_TASK_MAX_LOG_READ_BYTES,
          "params.limitBytes",
        ),
      );
    case "backgroundCancel":
      return await backgroundTasks.cancel(
        request.workspaceRoot,
        stringValue(params.taskId, "params.taskId"),
      );
    case "probe":
      return await executor.probe();
    case "canonicalPath":
      return await executor.canonicalPath(stringValue(params.path, "params.path"));
    case "readFile":
      return await executor.readFile(
        stringValue(params.path, "params.path"),
        numberValue(params.limitBytes, request.policy.maxOutputBytes / 2, "params.limitBytes"),
      );
    case "listDirectory":
      return await executor.listDirectory(stringValue(params.path, "params.path"));
    case "listTree":
      return await executor.listTree(
        stringValue(params.path, "params.path"),
        numberValue(params.depth, 2, "params.depth"),
        numberValue(params.maxEntries, 400, "params.maxEntries"),
      );
    case "search": {
      const paths = Array.isArray(params.paths)
        ? params.paths.map((entry) => stringValue(entry, "params.paths[]"))
        : ["."];
      return await executor.search(
        stringValue(params.query, "params.query"),
        paths,
        numberValue(params.maxResults, 200, "params.maxResults"),
      );
    }
    case "execute": {
      if (!Array.isArray(params.argv)) {
        throw new BridgeError("PROTOCOL_MISMATCH", "params.argv must be an array");
      }
      const argv = params.argv.map((entry) => stringValue(entry, "params.argv[]"));
      const rawOptions = params.options === undefined ? {} : record(params.options, "params.options");
      const stdin =
        rawOptions.stdinBase64 === undefined
          ? undefined
          : decodeWorkspaceContent(
              stringValue(rawOptions.stdinBase64, "params.options.stdinBase64"),
            );
      let outputQueue = Promise.resolve();
      const emit = (channel: RemoteOutputEvent["channel"], chunk: string): void => {
        outputQueue = outputQueue.then(async () => {
          await vscode.commands.executeCommand(request.outputCommand, {
            channel,
            chunk,
            id: request.id,
          } satisfies RemoteOutputEvent);
        });
      };
      const options: ExecuteOptions = {
        ...(typeof rawOptions.cwd === "string" ? { cwd: rawOptions.cwd } : {}),
        ...(rawOptions.env && typeof rawOptions.env === "object" && !Array.isArray(rawOptions.env)
          ? { env: rawOptions.env as Record<string, string | null> }
          : {}),
        ...(typeof rawOptions.timeoutMs === "number" ? { timeoutMs: rawOptions.timeoutMs } : {}),
        sideEffect: rawOptions.sideEffect === true,
        signal,
        ...(stdin ? { stdin } : {}),
        onStdout: (chunk) => emit("stdout", chunk),
        onStderr: (chunk) => emit("stderr", chunk),
      };
      const result = await executor.execute(argv, options);
      await outputQueue;
      return result;
    }
    case "stdioStart": {
      await stdioSessions.start({
        adapterId:
          params.adapterId === null || params.adapterId === undefined
            ? null
            : stringValue(params.adapterId, "params.adapterId"),
        args: stringArray(params.args, "params.args"),
        executable: stringValue(params.executable, "params.executable"),
        id: request.id,
        maxFrameBytes: Math.min(request.policy.maxOutputBytes, REMOTE_STDIO_MAX_FRAME_BYTES),
        serverName:
          params.serverName === null || params.serverName === undefined
            ? null
            : stringValue(params.serverName, "params.serverName"),
        workspaceRoot: request.workspaceRoot,
      });
      return { started: true };
    }
    case "stdioWrite":
      await stdioSessions.write(
        request.id,
        stringValue(params.chunk, "params.chunk"),
        Math.min(request.policy.maxOutputBytes, REMOTE_STDIO_MAX_FRAME_BYTES),
      );
      return { written: true };
    case "stdioEnd":
      stdioSessions.end(request.id);
      return { ended: true };
    case "stdioStop":
      stdioSessions.stop(request.id);
      return { stopped: true };
    case "cancel":
    case "resultStatus":
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Operation control requests must be handled before operation dispatch",
      );
  }
}

function operationKey(request: RemoteExecutorCommandRequest, operationId: string): string {
  return [request.hostId, request.workspaceRoot, operationId].join("\0");
}

async function executeRequest(
  request: RemoteExecutorCommandRequest,
): Promise<RemoteExecutorCommandResponse> {
  try {
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.id !== "string" ||
      typeof request.hostId !== "string" ||
      typeof request.workspaceRoot !== "string" ||
      request.outputCommand !== REMOTE_OUTPUT_COMMAND ||
      !request.policy ||
      !Number.isInteger(request.policy.commandTimeoutMs) ||
      !Number.isInteger(request.policy.maxOutputBytes)
    ) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Invalid remote executor request");
    }
    if (request.operation === "cancel") {
      validateWorkspace(request);
      const operationId = stringValue(
        record(request.params, "params").operationId,
        "params.operationId",
      );
      return {
        ok: true,
        result: {
          cancelled: operationLedger.cancel(operationKey(request, operationId)),
          operationId,
        },
      };
    }
    if (request.operation === "resultStatus") {
      validateWorkspace(request);
      const idempotencyKey = idempotencyKeyValue(
        record(request.params, "params").idempotencyKey,
      );
      return {
        ok: true,
        result: operationLedger.status(operationKey(request, idempotencyKey)),
      };
    }
    const executor = executorFor(request);
    if (request.operation !== "execute") {
      return { ok: true, result: await dispatch(request, executor) };
    }
    const idempotencyKey = idempotencyKeyValue(
      record(request.params, "params").idempotencyKey,
    );
    const operation = operationLedger.start(
      operationKey(request, idempotencyKey),
      operationKey(request, request.id),
      operationFingerprint(request),
      async (signal) => await dispatch(request, executor, signal),
    );
    try {
      return {
        ok: true,
        result: resultWithIdempotencyOutcome(
          await operation.result,
          operation.outcome,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: errorWithIdempotencyOutcome(error, operation.outcome),
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: asBridgeError(error, "REMOTE_TRANSPORT_DISCONNECTED").toPayload(),
    };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REMOTE_EXECUTOR_COMMAND, executeRequest),
    vscode.commands.registerCommand(REMOTE_EXECUTOR_PING_COMMAND, () => ({
      capabilities: [...REMOTE_EXECUTOR_CAPABILITIES],
      executorVersion: REMOTE_EXECUTOR_VERSION,
      protocolVersion: REMOTE_EXECUTOR_PROTOCOL_VERSION,
      remoteName: vscode.env.remoteName,
    })),
  );
}

export function deactivate(): void {
  operationLedger.close();
  backgroundTasks.close();
  stdioSessions.close();
  for (const executor of executors.values()) {
    executor.close();
  }
  executors.clear();
}
