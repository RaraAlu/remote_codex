import * as vscode from "vscode";
import { asBridgeError, BridgeError } from "../core/errors.js";
import { LocalProcessExecutor } from "../core/local-process-executor.js";
import type { ExecuteOptions } from "../core/ssh-executor.js";
import type { BridgeConfig } from "../core/types.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  type RemoteExecutorCommandRequest,
  type RemoteExecutorCommandResponse,
  type RemoteOutputEvent,
} from "../core/vscode-transport.js";

const executors = new Map<string, LocalProcessExecutor>();

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

function numberValue(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BridgeError("PROTOCOL_MISMATCH", `${name} must be an integer`);
  }
  return value;
}

function validateWorkspace(request: RemoteExecutorCommandRequest): void {
  if (vscode.env.remoteName !== "ssh-remote") {
    throw new BridgeError(
      "REMOTE_TRANSPORT_DISCONNECTED",
      "Codex Bridge executor is not running in a Remote SSH extension host",
    );
  }
  const matches = vscode.workspace.workspaceFolders?.some(
    (folder) => folder.uri.scheme === "vscode-remote" && folder.uri.path === request.workspaceRoot,
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
  const config: BridgeConfig = {
    version: 1,
    host: request.hostId,
    workspaceRoot: request.workspaceRoot,
    connectionMode: "vscode-remote",
    localExecution: "deny",
    remoteHelper: "vscode-extension",
    codexExecutable: "codex",
    sshExecutable: "ssh",
    remoteMcpRouting: "local",
    remoteMcpAccess: "enabled",
    commandTimeoutMs: request.policy.commandTimeoutMs,
    maxOutputBytes: request.policy.maxOutputBytes,
    maxParallelReads: 8,
    maxParallelWrites: 1,
    connectTimeoutSeconds: 10,
  };
  const executor = new LocalProcessExecutor(config);
  executors.set(key, executor);
  return executor;
}

async function dispatch(
  request: RemoteExecutorCommandRequest,
  executor: LocalProcessExecutor,
): Promise<unknown> {
  const params = record(request.params, "params");
  switch (request.operation) {
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
        onStdout: (chunk) => emit("stdout", chunk),
        onStderr: (chunk) => emit("stderr", chunk),
      };
      const result = await executor.execute(argv, options);
      await outputQueue;
      return result;
    }
  }
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
      typeof request.outputCommand !== "string" ||
      !request.policy ||
      !Number.isInteger(request.policy.commandTimeoutMs) ||
      !Number.isInteger(request.policy.maxOutputBytes)
    ) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Invalid remote executor request");
    }
    const executor = executorFor(request);
    return { ok: true, result: await dispatch(request, executor) };
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
  );
}

export function deactivate(): void {
  for (const executor of executors.values()) {
    executor.close();
  }
  executors.clear();
}
