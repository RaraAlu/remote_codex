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
  "REMOTE_TRANSPORT_DISCONNECTED",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export type WorkspaceTarget = "local" | "remote";
export type WorkspaceRootRole = "primary" | "secondary";
export type WorkspaceAccessRole = WorkspaceRootRole | "conversation";
export type ConversationResourceKind = "directory" | "file";

export interface WorkspaceRootConfig {
  id: string;
  target: WorkspaceTarget;
  role: WorkspaceRootRole;
  path: string;
  displayName: string;
}

export interface ConversationResourceConfig {
  id: string;
  target: "local";
  role: "conversation";
  kind: ConversationResourceKind;
  path: string;
  displayName: string;
  threadId: string;
}

export type WorkspaceToolRoot = WorkspaceRootConfig | ConversationResourceConfig;

export interface BridgeConfig {
  version: 2;
  host: string;
  roots: WorkspaceRootConfig[];
  /** Runtime compatibility alias for the unique remote primary root. */
  workspaceRoot: string;
  connectionMode: "openssh" | "vscode-remote";
  localExecution: "allow";
  remoteHelper: "none" | "vscode-extension";
  sshUser?: string;
  sshPort?: number;
  identityFile?: string;
  sshExecutable: string;
  remoteMcpRouting: "auto" | "local";
  remoteMcpAccess: "enabled" | "all";
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxParallelReads: number;
  maxParallelWrites: 1;
  connectTimeoutSeconds: number;
  vscodeTransport?: VsCodeTransportDescriptor;
}

export interface VsCodeTransportDescriptor {
  endpoint: string;
  sessionId: string;
  token: string;
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
  rootId: string;
  rootRole: WorkspaceAccessRole;
  rootPath: string | null;
  target: WorkspaceTarget;
}

export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ToolResult<T> extends ToolRequestContext {
  ok: boolean;
  remoteCwd: string | null;
  data: T | null;
  truncated: boolean;
  error: BridgeErrorPayload | null;
}

export interface RemoteCommandResult {
  actualCwd: string;
  durationMs: number;
  exitCode: number | null;
  idempotencyOutcome?: "executed" | "joined" | "replayed";
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  transportTiming?: RemoteTransportTiming;
  truncated: boolean;
}

export interface RemoteTransportTiming {
  controllerCommandAckMs: number | null;
  controllerCompletionMs: number;
  controllerFirstOutputMs?: number;
  controllerOutputEvents: number;
  shimTransportTotalMs?: number;
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

export interface WorkspacePatchReplacement {
  oldText: string;
  newText: string;
}

export type WorkspaceMutationOperation =
  | "write"
  | "patch"
  | "mkdir"
  | "rename"
  | "delete";

export interface WorkspaceMutationResult {
  operation: WorkspaceMutationOperation;
  canonicalPath: string;
  destinationCanonicalPath?: string;
  bytesWritten: number;
  hash?: string;
  mode?: string;
  modifiedAtMs?: number;
  size?: number;
  idempotencyOutcome?: "executed" | "joined" | "replayed";
}

export type RemoteBackgroundTaskState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "unknown";

export interface RemoteBackgroundTaskSummary {
  taskId: string;
  status: RemoteBackgroundTaskState;
  actualCwd: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  exitCode: number | null;
  signal: string | null;
  cancellationRequested: boolean;
  logBaseCursor: number;
  logCursor: number;
  idempotencyOutcome?: "executed" | "joined" | "replayed";
}

export interface RemoteBackgroundLogEvent {
  channel: "stderr" | "stdout";
  contentBase64: string;
  cursor: number;
}

export interface RemoteBackgroundLogResult {
  task: RemoteBackgroundTaskSummary;
  events: RemoteBackgroundLogEvent[];
  nextCursor: number;
  truncated: boolean;
  hasMore: boolean;
}

export type BridgeClientSource = "vscode" | "external-cli" | "external-mcp";

export interface BridgeClientIdentity {
  clientId: string;
  clientSource: BridgeClientSource;
}

export interface AuditEvent {
  timestamp: string;
  requestId?: string;
  operationId?: string;
  connectionId?: string;
  sessionId?: string;
  clientId?: string;
  clientSource?: BridgeClientSource;
  hostId?: string;
  workspaceRoot?: string;
  remoteCwd?: string;
  rootId?: string;
  rootRole?: WorkspaceAccessRole;
  rootPath?: string;
  target?: WorkspaceTarget;
  operation: string;
  state?: BridgeState;
  outcome: "started" | "succeeded" | "failed" | "cancelled" | "unknown";
  durationMs?: number;
  exitCode?: number | null;
  truncated?: boolean;
  details?: Record<string, unknown>;
}
