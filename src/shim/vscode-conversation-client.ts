import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import WebSocket, { type RawData } from "ws";
import { discoverExternalCliSessions } from "./external-session-registry.js";
import { isRecord, isRpcRequest, isRpcResponse, type RpcId } from "./rpc.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
  timeout: NodeJS.Timeout;
}

function rawMessage(data: RawData): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

function rpcError(value: unknown): Error {
  if (!isRecord(value)) {
    return new Error("VS Code Codex app-server returned an unknown error");
  }
  const message =
    typeof value.message === "string" ? value.message : "VS Code Codex request failed";
  return new Error(message);
}

export class VsCodeConversationClient {
  readonly descriptor: ExternalCliSessionDescriptor;
  readonly #socket: WebSocket;
  readonly #pending = new Map<RpcId, PendingRequest>();
  #nextId = 1;

  private constructor(
    descriptor: ExternalCliSessionDescriptor,
    socket: WebSocket,
  ) {
    this.descriptor = descriptor;
    this.#socket = socket;
    socket.on("message", (data) => this.#handleMessage(data));
    socket.once("close", () => {
      this.#rejectPending(new Error("VS Code Codex app-server connection closed"));
    });
    socket.once("error", (error) => {
      this.#rejectPending(error);
    });
  }

  static async connect(
    descriptor: ExternalCliSessionDescriptor,
  ): Promise<VsCodeConversationClient> {
    const token = await readFile(descriptor.tokenPath, "utf8");
    if (!token || /[\r\n]/.test(token)) {
      throw new Error("VS Code Codex gateway token is invalid");
    }
    const socket = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new VsCodeConversationClient(descriptor, socket);
    await client.request("initialize", {
      clientInfo: {
        name: "codex_vscode_bridge_mcp",
        title: "Codex VS Code Bridge MCP",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return client;
  }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("VS Code Codex app-server is not connected");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<unknown>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`VS Code Codex request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.#pending.set(id, { reject, resolve: resolvePromise, timeout });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return await result;
  }

  notify(method: string, params: unknown): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ method, params }));
    }
  }

  close(): void {
    this.#socket.close();
  }

  get isOpen(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  #handleMessage(data: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(rawMessage(data)) as unknown;
    } catch {
      this.#socket.close(1003, "Invalid JSON-RPC");
      return;
    }
    if (isRpcResponse(message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(rpcError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isRpcRequest(message)) {
      const decision = message.method.endsWith("/requestApproval")
        ? { decision: "decline" }
        : undefined;
      this.#socket.send(
        JSON.stringify(
          decision
            ? { id: message.id, result: decision }
            : {
                id: message.id,
                error: {
                  code: -32601,
                  message: `External MCP client cannot handle ${message.method}`,
                },
              },
        ),
      );
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

const persistentClients = new Map<number, VsCodeConversationClient>();

async function persistentClient(
  descriptor: ExternalCliSessionDescriptor,
): Promise<VsCodeConversationClient> {
  const existing = persistentClients.get(descriptor.pid);
  if (
    existing?.isOpen &&
    existing.descriptor.endpoint === descriptor.endpoint
  ) {
    return existing;
  }
  existing?.close();
  const client = await VsCodeConversationClient.connect(descriptor);
  persistentClients.set(descriptor.pid, client);
  return client;
}

async function withClient<T>(
  descriptor: ExternalCliSessionDescriptor,
  operation: (client: VsCodeConversationClient) => Promise<T>,
): Promise<T> {
  return await operation(await persistentClient(descriptor));
}

function sessionSummary(descriptor: ExternalCliSessionDescriptor): Record<string, unknown> {
  return {
    sessionPid: descriptor.pid,
    host: descriptor.host,
    workspaceRoot: descriptor.workspaceRoot,
    activeThreadId: descriptor.threadId ?? null,
    startedAtMs: descriptor.startedAtMs,
  };
}

export async function listVsCodeConversations(limit = 20): Promise<unknown> {
  const sessions = await discoverExternalCliSessions();
  const results = await Promise.all(
    sessions.map(async (descriptor) => {
      try {
        const threads = await withClient(descriptor, (client) =>
          client.request("thread/list", {
            limit,
            sortDirection: "desc",
            sortKey: "updated_at",
            sourceKinds: ["vscode"],
          }),
        );
        return { ...sessionSummary(descriptor), threads };
      } catch (error) {
        return {
          ...sessionSummary(descriptor),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return { sessions: results };
}

async function findConversation(
  threadId: string,
  sessionPid?: number,
): Promise<{
  client: VsCodeConversationClient;
  descriptor: ExternalCliSessionDescriptor;
}> {
  const sessions = (await discoverExternalCliSessions()).filter(
    (descriptor) => sessionPid === undefined || descriptor.pid === sessionPid,
  );
  let lastError: unknown;
  for (const descriptor of sessions) {
    const client = await persistentClient(descriptor);
    try {
      await client.request("thread/read", { threadId, includeTurns: false });
      return { client, descriptor };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `VS Code Codex thread ${threadId} is not available in an active Bridge session${
      lastError ? `: ${String(lastError)}` : ""
    }`,
  );
}

export async function readVsCodeConversation(
  threadId: string,
  limit = 20,
  sessionPid?: number,
): Promise<unknown> {
  const { client, descriptor } = await findConversation(threadId, sessionPid);
  const turns = await client.request("thread/turns/list", {
    threadId,
    limit,
    itemsView: "full",
    sortDirection: "desc",
  });
  return { ...sessionSummary(descriptor), threadId, turns };
}

function activeTurnId(turns: unknown): string | undefined {
  if (!isRecord(turns) || !Array.isArray(turns.data)) {
    return undefined;
  }
  const active = turns.data.find(
    (turn) =>
      isRecord(turn) &&
      typeof turn.id === "string" &&
      (turn.status === "inProgress" || turn.status === "in_progress"),
  );
  return isRecord(active) && typeof active.id === "string" ? active.id : undefined;
}

export async function interveneVsCodeConversation(options: {
  expectedTurnId?: string;
  mode: "auto" | "steer" | "new-turn";
  sessionPid?: number;
  text: string;
  threadId: string;
}): Promise<unknown> {
  const { client, descriptor } = await findConversation(
    options.threadId,
    options.sessionPid,
  );
  let turnId = options.expectedTurnId;
  if (options.mode !== "new-turn" && !turnId) {
    const turns = await client.request("thread/turns/list", {
      threadId: options.threadId,
      limit: 10,
      itemsView: "summary",
      sortDirection: "desc",
    });
    turnId = activeTurnId(turns);
  }
  const input = [{ type: "text", text: options.text, text_elements: [] }];
  const metadata = { codex_bridge_origin: "external-cli-mcp" };
  let result: unknown;
  let action: "steer" | "new-turn";
  if (options.mode === "steer" || (options.mode === "auto" && turnId)) {
    if (!turnId) {
      throw new Error("No active VS Code Codex turn is available to steer");
    }
    action = "steer";
    result = await client.request("turn/steer", {
      threadId: options.threadId,
      expectedTurnId: turnId,
      input,
      clientUserMessageId: randomUUID(),
      responsesapiClientMetadata: metadata,
    });
  } else {
    action = "new-turn";
    result = await client.request("turn/start", {
      threadId: options.threadId,
      input,
      clientUserMessageId: randomUUID(),
      responsesapiClientMetadata: metadata,
    });
  }
  return {
    ...sessionSummary(descriptor),
    threadId: options.threadId,
    action,
    result,
  };
}

export async function interruptVsCodeConversation(options: {
  sessionPid?: number;
  threadId: string;
  turnId: string;
}): Promise<unknown> {
  const { client, descriptor } = await findConversation(
    options.threadId,
    options.sessionPid,
  );
  const result = await client.request("turn/interrupt", {
    threadId: options.threadId,
    turnId: options.turnId,
  });
  return { ...sessionSummary(descriptor), ...options, result };
}

export function closeVsCodeConversationClients(): void {
  for (const client of persistentClients.values()) {
    client.close();
  }
  persistentClients.clear();
}
