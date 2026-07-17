export const BRIDGE_STATES = [
  "disabled",
  "configuring",
  "connecting",
  "ready",
  "busy",
  "degraded",
  "disconnected",
  "incompatible",
] as const;

export type BridgeState = (typeof BRIDGE_STATES)[number];

export const BRIDGE_ERROR_CODES = [
  "BRIDGE_NOT_READY",
  "SSH_DISCONNECTED",
  "HOST_KEY_MISMATCH",
  "PATH_OUTSIDE_ROOT",
  "FILE_CONFLICT",
  "COMMAND_DENIED",
  "LOCAL_EXECUTION_BLOCKED",
  "TIMEOUT",
  "CANCELLED",
  "PROTOCOL_MISMATCH",
  "OUTPUT_TRUNCATED",
  "RESULT_UNKNOWN",
  "INVALID_CONFIG",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface BridgeConfig {
  version: 1;
  host: string;
  workspaceRoot: string;
  connectionMode: "openssh";
  localExecution: "deny";
  remoteHelper: "none";
  codexExecutable: string;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxParallelReads: number;
  maxParallelWrites: 1;
  connectTimeoutSeconds: number;
}

export interface RemoteIdentity {
  hostId: string;
  hostname: string;
  machineId: string;
  workspaceRoot: string;
}

export interface ToolRequestContext {
  requestId: string;
  connectionId: string;
  hostId: string;
}

export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ToolResult<T> extends ToolRequestContext {
  ok: boolean;
  remoteCwd: string;
  data: T | null;
  truncated: boolean;
  error: BridgeErrorPayload | null;
}

export interface RemoteCommandResult {
  actualCwd: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  truncated: boolean;
}

export interface RemoteFileMetadata {
  canonicalPath: string;
  hash: string;
  mode: string;
  modifiedAtMs: number;
  size: number;
}

export interface RemoteFileRead extends RemoteFileMetadata {
  contentBase64: string;
  truncated: boolean;
}

export interface AuditEvent {
  timestamp: string;
  requestId?: string;
  connectionId?: string;
  sessionId?: string;
  hostId?: string;
  workspaceRoot?: string;
  remoteCwd?: string;
  operation: string;
  state?: BridgeState;
  outcome: "started" | "succeeded" | "failed" | "cancelled" | "unknown";
  durationMs?: number;
  exitCode?: number | null;
  truncated?: boolean;
  details?: Record<string, unknown>;
}
