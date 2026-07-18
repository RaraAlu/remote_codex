import type { BridgeErrorPayload } from "./types.js";

export const REMOTE_EXECUTOR_COMMAND = "codexRemoteBridge.executor.execute";
export const REMOTE_EXECUTOR_EXTENSION_ID = "zkbot.codex-remote-bridge-executor";
export const REMOTE_OUTPUT_COMMAND = "codexRemoteBridge.transport.output";

export type RemoteExecutorOperation =
  | "canonicalPath"
  | "execute"
  | "listDirectory"
  | "listTree"
  | "probe"
  | "readFile"
  | "search";

export interface RemoteExecutorCommandRequest {
  hostId: string;
  id: string;
  operation: RemoteExecutorOperation;
  outputCommand: string;
  policy: {
    commandTimeoutMs: number;
    maxOutputBytes: number;
  };
  params: Record<string, unknown>;
  workspaceRoot: string;
}

export interface RemoteExecutorCommandResponse {
  error?: BridgeErrorPayload;
  ok: boolean;
  result?: unknown;
}

export interface RemoteOutputEvent {
  channel: "stderr" | "stdout";
  chunk: string;
  id: string;
}

export interface TransportRequest extends RemoteExecutorCommandRequest {
  token: string;
}

export type TransportMessage =
  | { channel: "stderr" | "stdout"; chunk: string; id: string; type: "output" }
  | {
      error?: BridgeErrorPayload;
      id: string;
      result?: unknown;
      type: "response";
    };

export function isRemoteOutputEvent(value: unknown): value is RemoteOutputEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.chunk === "string" &&
    (event.channel === "stdout" || event.channel === "stderr")
  );
}

export function isTransportRequest(value: unknown): value is TransportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    typeof request.id === "string" &&
    typeof request.token === "string" &&
    typeof request.hostId === "string" &&
    typeof request.workspaceRoot === "string" &&
    typeof request.outputCommand === "string" &&
    Boolean(request.policy) &&
    typeof request.policy === "object" &&
    !Array.isArray(request.policy) &&
    typeof request.operation === "string" &&
    [
      "canonicalPath",
      "execute",
      "listDirectory",
      "listTree",
      "probe",
      "readFile",
      "search",
    ].includes(request.operation) &&
    Boolean(request.params) &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  );
}
