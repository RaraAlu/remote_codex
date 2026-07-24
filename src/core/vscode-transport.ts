import type { BridgeErrorPayload } from "./types.js";

export const REMOTE_EXECUTOR_COMMAND = "codexRemoteBridge.executor.execute";
export const REMOTE_EXECUTOR_EXTENSION_ID = "zkbot.codex-remote-bridge-executor";
export const REMOTE_EXECUTOR_PING_COMMAND = "codexRemoteBridge.executor.ping";
export const REMOTE_EXECUTOR_PROTOCOL_VERSION = 4;
export const REMOTE_EXECUTOR_VERSION = "0.2.8";
export const REMOTE_OUTPUT_COMMAND = "codexRemoteBridge.transport.output";
export const REMOTE_STDIO_MAX_FRAME_BYTES = 256 * 1024;

export const REMOTE_EXECUTOR_CAPABILITIES = [
  "canonicalPath",
  "execute",
  "listDirectory",
  "listTree",
  "probe",
  "readFile",
  "search",
  "stdioEnd",
  "stdioStart",
  "stdioStop",
  "stdioWrite",
] as const;

export type RemoteExecutorCapability = (typeof REMOTE_EXECUTOR_CAPABILITIES)[number];

export interface RemoteExecutorPing {
  capabilities: readonly RemoteExecutorCapability[];
  executorVersion?: string;
  protocolVersion?: number;
  remoteName: "ssh-remote";
}

export type RemoteExecutorOperation =
  | "canonicalPath"
  | "execute"
  | "listDirectory"
  | "listTree"
  | "probe"
  | "readFile"
  | "search"
  | "stdioEnd"
  | "stdioStart"
  | "stdioStop"
  | "stdioWrite";

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

export type RemoteStdioEvent =
  | {
      channel: "stderr" | "stdout";
      chunk: string;
      event: "data";
      id: string;
    }
  | {
      event: "exit";
      exitCode: number | null;
      id: string;
      signal: string | null;
    };

export interface TransportRequest extends RemoteExecutorCommandRequest {
  token: string;
}

export type TransportStdioInput =
  | { chunk: string; id: string; type: "stdioInput" }
  | { id: string; type: "stdioEnd" };

export type TransportMessage =
  | { channel: "stderr" | "stdout"; chunk: string; id: string; type: "output" }
  | { channel: "stderr" | "stdout"; chunk: string; id: string; type: "stdioOutput" }
  | { id: string; type: "stdioReady" }
  | {
      exitCode: number | null;
      id: string;
      signal: string | null;
      type: "stdioExit";
    }
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

export function isRemoteStdioEvent(value: unknown): value is RemoteStdioEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string") {
    return false;
  }
  if (event.event === "data") {
    return (
      typeof event.chunk === "string" &&
      (event.channel === "stdout" || event.channel === "stderr")
    );
  }
  return (
    event.event === "exit" &&
    (event.exitCode === null || typeof event.exitCode === "number") &&
    (event.signal === null || typeof event.signal === "string")
  );
}

export function isTransportStdioInput(value: unknown): value is TransportStdioInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    typeof input.id === "string" &&
    ((input.type === "stdioInput" && typeof input.chunk === "string") ||
      input.type === "stdioEnd")
  );
}

export function isRemoteExecutorPing(value: unknown): value is RemoteExecutorPing {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const ping = value as Record<string, unknown>;
  const capabilities = Array.isArray(ping.capabilities) ? ping.capabilities : null;
  return (
    ping.remoteName === "ssh-remote" &&
    capabilities !== null &&
    REMOTE_EXECUTOR_CAPABILITIES.every((capability) => capabilities.includes(capability))
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
      "stdioStart",
    ].includes(request.operation) &&
    Boolean(request.params) &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  );
}
