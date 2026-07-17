export type RpcId = number | string;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isRpcRequest(message: unknown): message is RpcRequest {
  return (
    isRecord(message) &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    typeof message.method === "string"
  );
}

export function isRpcNotification(message: unknown): message is RpcNotification {
  return isRecord(message) && !("id" in message) && typeof message.method === "string";
}

export function isRpcResponse(message: unknown): message is RpcResponse {
  return (
    isRecord(message) &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    !("method" in message) &&
    ("result" in message || "error" in message)
  );
}

export function parseRpcLine(line: string): RpcMessage {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new TypeError("JSON-RPC message must be an object");
  }
  return parsed as unknown as RpcMessage;
}
