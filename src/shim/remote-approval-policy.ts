import {
  isRecord,
  isRpcRequest,
  isRpcResponse,
  type RpcId,
  type RpcMessage,
} from "./rpc.js";

export type RemoteApprovalMode = "ask" | "never";

function explicitApprovalMode(
  params: Record<string, unknown>,
): RemoteApprovalMode | undefined {
  if (params.approvalPolicy === "never") {
    return "never";
  }
  if (params.approvalPolicy !== undefined && params.approvalPolicy !== null) {
    return "ask";
  }
  if (params.permissions === "full-access") {
    return "never";
  }
  if (typeof params.permissions === "string") {
    return "ask";
  }
  return undefined;
}

export class RemoteApprovalPolicyTracker {
  readonly #pendingThreadStarts = new Map<RpcId, RemoteApprovalMode>();
  readonly #threadModes = new Map<string, RemoteApprovalMode>();

  observeClientMessage(message: RpcMessage): void {
    if (!isRpcRequest(message) || !isRecord(message.params)) {
      return;
    }
    const params = message.params;
    const explicit = explicitApprovalMode(params);

    if (message.method === "thread/start") {
      this.#pendingThreadStarts.set(message.id, explicit ?? "ask");
      return;
    }
    if (message.method !== "thread/resume" && message.method !== "turn/start") {
      return;
    }
    if (typeof params.threadId !== "string") {
      return;
    }
    if (explicit) {
      this.#threadModes.set(params.threadId, explicit);
    } else if (message.method === "thread/resume" && !this.#threadModes.has(params.threadId)) {
      this.#threadModes.set(params.threadId, "ask");
    }
  }

  observeServerMessage(message: RpcMessage): void {
    if (!isRpcResponse(message)) {
      return;
    }
    const mode = this.#pendingThreadStarts.get(message.id);
    if (!mode) {
      return;
    }
    this.#pendingThreadStarts.delete(message.id);
    const thread =
      isRecord(message.result) && isRecord(message.result.thread)
        ? message.result.thread
        : null;
    if (typeof thread?.id === "string") {
      this.#threadModes.set(thread.id, mode);
    }
  }

  modeForThread(threadId: string): RemoteApprovalMode {
    return this.#threadModes.get(threadId) ?? "ask";
  }

  requiresApproval(threadId: string): boolean {
    return this.modeForThread(threadId) !== "never";
  }
}
