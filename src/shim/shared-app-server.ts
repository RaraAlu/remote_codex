import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { AuditLog } from "../core/audit-log.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import { loadLocalWorkspaceContext } from "../core/local-workspace-context.js";
import {
  bridgeExternalCliDir,
  bridgeExternalCliSessionPath,
  bridgeExternalCliTokenPath,
  bridgeUpstreamTokenPath,
} from "../core/locations.js";
import type { SpawnProcess } from "../core/ssh-executor.js";
import type {
  AuditEvent,
  BridgeClientIdentity,
  BridgeConfig,
} from "../core/types.js";
import {
  RemoteTurnClientTracker,
  RemoteToolCallCoordinator,
  ShimProxy,
  type RpcMessageWriter,
} from "./proxy.js";
import { RemoteApprovalPolicyTracker } from "./remote-approval-policy.js";
import {
  isRecord,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  parseRpcLine,
  type RpcId,
  type RpcMessage,
} from "./rpc.js";

const LOOPBACK_HOST = "127.0.0.1";
const EXTERNAL_TOKEN_ENV = "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN";
const NOTIFICATION_DEDUP_MS = 1_000;
const EXTERNAL_CLOSE_CODE = 1_012;
const EXTERNAL_CLOSE_REASON = "Bridge app-server restarting";
const EXTERNAL_CLOSE_GRACE_MS = 250;
const EXTERNAL_DISCONNECT_INTERRUPT_TIMEOUT_MS = 2_000;

interface RelayedNotification {
  expiresAtMs: number;
  sources: Set<string>;
}

interface PendingClientRequest {
  clientIdentity: BridgeClientIdentity;
  method: string;
  threadId?: string;
  turnId?: string;
}

interface PendingExternalRequest {
  details: Record<string, unknown>;
  operationId: string;
  startedAtMs: number;
}

interface ExternalTurnInterruptSummary {
  confirmed: number;
  requested: number;
  unconfirmed: number;
}

export interface ExternalCliSessionDescriptor {
  version: 1;
  endpoint: string;
  host: string;
  pid: number;
  startedAtMs: number;
  tokenEnv: string;
  tokenPath: string;
  workspaceRoot: string;
  threadId?: string;
}

export interface SharedAppServerOptions {
  appServerArgs: readonly string[];
  appServerCwd?: string;
  auditPath: string;
  codexExecutable: string;
  config: BridgeConfig | null;
  controlDir: string;
  localWorkspaceContextPath?: string;
  localWorkspaceRoot?: string;
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  remoteMcpServers?: readonly string[];
  spawnCodex?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  spawnSsh?: SpawnProcess;
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  return match?.[1];
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return address.port;
}

export function withSharedWebSocketTransport(
  appServerArgs: readonly string[],
  endpoint: string,
  tokenPath: string,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < appServerArgs.length; index += 1) {
    const argument = appServerArgs[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--stdio") {
      continue;
    }
    if (argument === "--listen") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--listen=")) {
      continue;
    }
    if (
      argument === "--ws-auth" ||
      argument === "--ws-token-file" ||
      argument === "--ws-token-sha256" ||
      argument === "--ws-shared-secret-file" ||
      argument === "--ws-issuer" ||
      argument === "--ws-audience" ||
      argument === "--ws-max-clock-skew-seconds"
    ) {
      index += 1;
      continue;
    }
    result.push(argument);
  }
  return [
    ...result,
    "--listen",
    endpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenPath,
  ];
}

function webSocketWriter(socket: WebSocket): RpcMessageWriter {
  return (message) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
}

function streamWriter(stream: Writable): RpcMessageWriter {
  return (message) => {
    stream.write(`${JSON.stringify(message)}\n`);
  };
}

function rawMessage(data: RawData): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

export class SharedAppServer {
  readonly #options: SharedAppServerOptions;
  readonly #audit: AuditLog;
  readonly #approvalPolicies = new RemoteApprovalPolicyTracker();
  readonly #remoteToolCalls = new RemoteToolCallCoordinator();
  readonly #turnClients = new RemoteTurnClientTracker();
  readonly #sessionPath = bridgeExternalCliSessionPath();
  readonly #externalTokenPath = bridgeExternalCliTokenPath();
  readonly #upstreamTokenPath = bridgeUpstreamTokenPath();
  readonly #startedAtMs = Date.now();
  #activeThreadId: string | undefined;
  #activeWorkspaceRoot: string;
  #child: ChildProcessWithoutNullStreams | null = null;
  #externalServer: WebSocketServer | null = null;
  #externalToken = "";
  #upstreamEndpoint = "";
  #upstreamToken = "";
  #descriptorQueue = Promise.resolve();
  #auditQueue = Promise.resolve();
  #stdioWriter: RpcMessageWriter | null = null;
  readonly #externalWriters = new Map<string, RpcMessageWriter>();
  readonly #externalRelayCounts = new Map<string, number>();
  readonly #externalCleanupTasks = new Set<Promise<void>>();
  readonly #relayedNotifications = new Map<string, RelayedNotification>();

  constructor(options: SharedAppServerOptions) {
    this.#options = options;
    this.#audit = new AuditLog(options.auditPath);
    this.#activeWorkspaceRoot =
      options.config?.workspaceRoot ??
      options.localWorkspaceRoot ??
      options.appServerCwd ??
      process.cwd();
  }

  async run(): Promise<number> {
    const input = this.#options.input ?? process.stdin;
    const output = this.#options.output ?? process.stdout;
    const errorOutput = this.#options.errorOutput ?? process.stderr;
    const spawnCodex = this.#options.spawnCodex ?? spawn;
    const directory = bridgeExternalCliDir();
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmodIfSupported(directory, 0o700);

    this.#upstreamToken = randomBytes(32).toString("base64url");
    this.#externalToken = randomBytes(32).toString("base64url");
    await writeFile(this.#upstreamTokenPath, this.#upstreamToken, { mode: 0o600 });
    await writeFile(this.#externalTokenPath, this.#externalToken, { mode: 0o600 });
    await chmodIfSupported(this.#upstreamTokenPath, 0o600);
    await chmodIfSupported(this.#externalTokenPath, 0o600);

    const upstreamPort = await reserveLoopbackPort();
    this.#upstreamEndpoint = `ws://${LOOPBACK_HOST}:${upstreamPort}`;
    const appServerArgs = withSharedWebSocketTransport(
      this.#options.appServerArgs,
      this.#upstreamEndpoint,
      this.#upstreamTokenPath,
    );
    const child = spawnCodex(this.#options.codexExecutable, appServerArgs, {
      cwd: this.#options.appServerCwd ?? this.#options.controlDir,
      env: process.env,
      stdio: "pipe",
    });
    this.#child = child;
    child.stderr.pipe(errorOutput, { end: false });
    child.stdout.pipe(errorOutput, { end: false });

    try {
      const upstream = await this.#connectUpstream();
      const externalPort = await this.#startExternalServer(errorOutput);
      await this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${externalPort}`);
      await this.#audit.write({
        operation: "external_cli.gateway",
        outcome: "started",
        hostId: this.#options.config?.host ?? "local",
        workspaceRoot: this.#activeWorkspaceRoot,
        details: { endpoint: `ws://${LOOPBACK_HOST}:${externalPort}` },
      });
      return await this.#runStdioClient(upstream, input, output, errorOutput);
    } finally {
      await this.#close();
    }
  }

  async #connectUpstream(): Promise<WebSocket> {
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await new Promise<WebSocket>((resolvePromise, reject) => {
          const socket = new WebSocket(this.#upstreamEndpoint, {
            headers: { Authorization: `Bearer ${this.#upstreamToken}` },
          });
          const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error("Timed out connecting to official Codex app-server"));
          }, 1_000);
          socket.once("open", () => {
            clearTimeout(timer);
            resolvePromise(socket);
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw new Error(`Could not connect to official Codex app-server: ${String(lastError)}`);
  }

  async #startExternalServer(errorOutput: Writable): Promise<number> {
    const server = new WebSocketServer({
      host: LOOPBACK_HOST,
      port: 0,
      verifyClient: ({ req }, done) => {
        const token = bearerToken(req.headers.authorization);
        done(secretMatches(token, this.#externalToken), 401, "Unauthorized");
      },
    });
    this.#externalServer = server;
    server.on("connection", (socket) => {
      void this.#serveExternalClient(socket, errorOutput);
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("listening", resolvePromise);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("External CLI gateway did not bind a loopback port");
    }
    return address.port;
  }

  async #serveExternalClient(socket: WebSocket, errorOutput: Writable): Promise<void> {
    const clientId = randomUUID();
    const clientIdentity: BridgeClientIdentity = {
      clientId,
      clientSource: "external-cli",
    };
    const buffered: string[] = [];
    const pendingClientRequests = new Map<RpcId, PendingClientRequest>();
    const pendingExternalRequests = new Map<RpcId, PendingExternalRequest>();
    let closed = false;
    socket.once("close", () => {
      closed = true;
    });
    const bufferMessage = (data: RawData): void => {
      buffered.push(rawMessage(data));
    };
    socket.on("message", bufferMessage);
    let upstream: WebSocket | null = null;
    let session: ShimProxy | null = null;
    try {
      upstream = await this.#connectUpstream();
      if (closed) {
        upstream.close();
        return;
      }
      for (const raw of buffered) {
        try {
          this.#observeExternalClientIdentity(parseRpcLine(raw), clientIdentity);
        } catch {
          break;
        }
      }
      session = this.#createSession(true, 1, clientIdentity);
      const writeUpstream = webSocketWriter(upstream);
      const writeExternalTransport = webSocketWriter(socket);
      const writeExternal: RpcMessageWriter = (message) => {
        if (isRpcResponse(message)) {
          const pending = pendingExternalRequests.get(message.id);
          if (pending) {
            pendingExternalRequests.delete(message.id);
            void this.#queueAudit({
              ...clientIdentity,
              operationId: pending.operationId,
              operation: "external_cli.request",
              outcome: message.error ? "failed" : "succeeded",
              durationMs: Date.now() - pending.startedAtMs,
              hostId: this.#options.config?.host ?? "local",
              workspaceRoot: this.#activeWorkspaceRoot,
              details: pending.details,
            });
          }
        }
        writeExternalTransport(message);
      };
      this.#externalWriters.set(clientId, writeExternal);
      this.#externalRelayCounts.set(clientId, 0);
      const writeClient = this.#downstreamWriter(clientId, writeExternal);
      const handleClient = (raw: string): void => {
        try {
          const message = parseRpcLine(raw);
          this.#observeExternalClientIdentity(message, clientIdentity);
          this.#observeClientMessage(
            message,
            pendingClientRequests,
            clientIdentity,
          );
          if ("method" in message) {
            const operationId = isRpcRequest(message)
              ? String(message.id)
              : randomUUID();
            const details = this.#externalRequestAuditDetails(message);
            if (isRpcRequest(message)) {
              pendingExternalRequests.set(message.id, {
                details,
                operationId,
                startedAtMs: Date.now(),
              });
            }
            void this.#queueAudit({
              ...clientIdentity,
              operationId,
              operation: "external_cli.request",
              outcome: isRpcRequest(message) ? "started" : "succeeded",
              hostId: this.#options.config?.host ?? "local",
              workspaceRoot: this.#activeWorkspaceRoot,
              details,
            });
          }
          void session
            ?.handleClientMessage(message, writeUpstream, writeClient)
            .catch((error) => {
              if (isRpcRequest(message)) {
                const pending = pendingExternalRequests.get(message.id);
                if (pending) {
                  pendingExternalRequests.delete(message.id);
                  void this.#queueAudit({
                    ...clientIdentity,
                    operationId: pending.operationId,
                    operation: "external_cli.request",
                    outcome: "failed",
                    durationMs: Date.now() - pending.startedAtMs,
                    hostId: this.#options.config?.host ?? "local",
                    workspaceRoot: this.#activeWorkspaceRoot,
                    details: {
                      ...pending.details,
                      errorType:
                        error instanceof Error ? error.name : typeof error,
                    },
                  });
                }
              }
              errorOutput.write(
                `codex-bridge: external client request failed: ${String(error)}\n`,
              );
            });
        } catch (error) {
          errorOutput.write(`codex-bridge: invalid external JSON-RPC: ${String(error)}\n`);
          socket.close(1003, "Invalid JSON-RPC");
        }
      };
      socket.off("message", bufferMessage);
      socket.on("message", (data) => handleClient(rawMessage(data)));
      await this.#queueAudit({
        ...clientIdentity,
        operationId: clientId,
        operation: "external_cli.connect",
        outcome: "succeeded",
        hostId: this.#options.config?.host ?? "local",
        workspaceRoot: this.#activeWorkspaceRoot,
      });
      upstream.on("message", (data) => {
        try {
          const message = parseRpcLine(rawMessage(data));
          this.#observeServerMessage(message, pendingClientRequests);
          void session
            ?.handleServerMessage(message, writeUpstream, writeClient)
            .catch((error) => {
              errorOutput.write(
                `codex-bridge: external server request failed: ${String(error)}\n`,
              );
            });
        } catch (error) {
          errorOutput.write(`codex-bridge: invalid upstream JSON-RPC: ${String(error)}\n`);
          upstream?.close();
        }
      });
      for (const raw of buffered) {
        handleClient(raw);
      }
      socket.once("close", () => {
        const cleanup = this.#handleExternalDisconnect(
          clientIdentity,
          pendingExternalRequests,
          upstream,
          session,
        ).catch((error) => {
          errorOutput.write(
            `codex-bridge: external client cleanup failed: ${String(error)}\n`,
          );
        });
        this.#externalCleanupTasks.add(cleanup);
        void cleanup.finally(() => this.#externalCleanupTasks.delete(cleanup));
      });
    } catch (error) {
      this.#externalWriters.delete(clientId);
      this.#externalRelayCounts.delete(clientId);
      upstream?.terminate();
      session?.closeSession();
      socket.close(1011, "Bridge upstream unavailable");
      errorOutput.write(`codex-bridge: external CLI connection failed: ${String(error)}\n`);
    }
  }

  async #handleExternalDisconnect(
    clientIdentity: BridgeClientIdentity,
    pendingExternalRequests: Map<RpcId, PendingExternalRequest>,
    upstream: WebSocket | null,
    session: ShimProxy | null,
  ): Promise<void> {
    const notificationsRelayedToVsCode =
      this.#externalRelayCounts.get(clientIdentity.clientId) ?? 0;
    for (const pending of pendingExternalRequests.values()) {
      void this.#queueAudit({
        ...clientIdentity,
        operationId: pending.operationId,
        operation: "external_cli.request",
        outcome: "cancelled",
        durationMs: Date.now() - pending.startedAtMs,
        hostId: this.#options.config?.host ?? "local",
        workspaceRoot: this.#activeWorkspaceRoot,
        details: {
          ...pending.details,
          reason: "client-disconnected",
        },
      });
    }
    pendingExternalRequests.clear();
    this.#externalWriters.delete(clientIdentity.clientId);
    this.#externalRelayCounts.delete(clientIdentity.clientId);
    session?.closeSession();
    const turnInterrupts = await this.#interruptExternalTurns(
      clientIdentity.clientId,
      upstream,
    );
    upstream?.close();
    await this.#queueAudit({
      ...clientIdentity,
      operationId: clientIdentity.clientId,
      operation: "external_cli.disconnect",
      outcome: turnInterrupts.unconfirmed === 0 ? "succeeded" : "unknown",
      hostId: this.#options.config?.host ?? "local",
      workspaceRoot: this.#activeWorkspaceRoot,
      details: { notificationsRelayedToVsCode, turnInterrupts },
    });
  }

  async #interruptExternalTurns(
    clientId: string,
    upstream: WebSocket | null,
  ): Promise<ExternalTurnInterruptSummary> {
    const turns = this.#turnClients.takeForClient(clientId);
    if (turns.length === 0) {
      return { confirmed: 0, requested: 0, unconfirmed: 0 };
    }
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      return {
        confirmed: 0,
        requested: turns.length,
        unconfirmed: turns.length,
      };
    }

    const pendingIds = new Set<RpcId>();
    let confirmed = 0;
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolvePromise) => {
      settle = resolvePromise;
    });
    const handleMessage = (data: RawData): void => {
      let message: ReturnType<typeof parseRpcLine>;
      try {
        message = parseRpcLine(rawMessage(data));
      } catch {
        return;
      }
      if (!isRpcResponse(message) || !pendingIds.delete(message.id)) {
        return;
      }
      if (!message.error) {
        confirmed += 1;
      }
      if (pendingIds.size === 0) {
        settle();
      }
    };
    upstream.on("message", handleMessage);
    for (const turn of turns) {
      const id = `external_disconnect_${randomUUID()}`;
      pendingIds.add(id);
      try {
        upstream.send(
          JSON.stringify({
            id,
            method: "turn/interrupt",
            params: turn,
          }),
        );
      } catch {
        pendingIds.delete(id);
      }
    }
    if (pendingIds.size === 0) {
      settle();
    }
    const timeout = setTimeout(settle, EXTERNAL_DISCONNECT_INTERRUPT_TIMEOUT_MS);
    timeout.unref();
    await settled;
    clearTimeout(timeout);
    upstream.off("message", handleMessage);
    return {
      confirmed,
      requested: turns.length,
      unconfirmed: turns.length - confirmed,
    };
  }

  async #runStdioClient(
    upstream: WebSocket,
    input: Readable,
    output: Writable,
    errorOutput: Writable,
  ): Promise<number> {
    const clientIdentity: BridgeClientIdentity = {
      clientId: "stdio",
      clientSource: "vscode",
    };
    const session = this.#createSession(true, 0, clientIdentity);
    const pendingClientRequests = new Map<RpcId, PendingClientRequest>();
    const writeUpstream = webSocketWriter(upstream);
    const writeClient = streamWriter(output);
    this.#stdioWriter = writeClient;
    const writeDownstream = this.#downstreamWriter("stdio", writeClient);
    const lines = createInterface({ input });
    let clientQueue = Promise.resolve();
    lines.on("line", (line) => {
      clientQueue = clientQueue
        .then(async () => {
          const message = parseRpcLine(line);
          this.#observeClientMessage(
            message,
            pendingClientRequests,
            clientIdentity,
          );
          await session.handleClientMessage(message, writeUpstream, writeDownstream);
        })
        .catch((error) => {
          errorOutput.write(`codex-bridge: invalid client JSON-RPC: ${String(error)}\n`);
        });
    });
    upstream.on("message", (data) => {
      try {
        const message = parseRpcLine(rawMessage(data));
        this.#observeServerMessage(message, pendingClientRequests);
        void session.handleServerMessage(message, writeUpstream, writeDownstream).catch((error) => {
          errorOutput.write(`codex-bridge: server request handling failed: ${String(error)}\n`);
        });
      } catch (error) {
        errorOutput.write(`codex-bridge: invalid server JSON-RPC: ${String(error)}\n`);
      }
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      this.#child?.kill(signal);
      upstream.close();
      session.closeSession();
    };
    const onSigInt = (): void => forwardSignal("SIGINT");
    const onSigTerm = (): void => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);
    let clientEnded = false;

    return await new Promise<number>((resolvePromise, reject) => {
      const finish = (code: number): void => {
        process.removeListener("SIGINT", onSigInt);
        process.removeListener("SIGTERM", onSigTerm);
        lines.close();
        session.closeSession();
        this.#stdioWriter = null;
        resolvePromise(code);
      };
      input.once("end", () => {
        clientEnded = true;
        void clientQueue.finally(async () => {
          await this.#closeExternalClients();
          upstream.close(1_001, "Bridge client input closed");
          setTimeout(() => this.#child?.kill("SIGTERM"), 25).unref();
        });
      });
      upstream.once("error", reject);
      this.#child?.once("error", reject);
      this.#child?.once("close", (code, signal) =>
        finish(clientEnded ? 0 : signal ? 128 : (code ?? 1)),
      );
    });
  }

  #createSession(
    observeApprovalPolicy: boolean,
    remoteToolPriority: number,
    clientIdentity: BridgeClientIdentity,
  ): ShimProxy {
    return new ShimProxy({
      appServerArgs: this.#options.appServerArgs,
      auditPath: this.#options.auditPath,
      codexExecutable: this.#options.codexExecutable,
      config: this.#options.config,
      controlDir: this.#options.controlDir,
      approvalPolicies: this.#approvalPolicies,
      clientIdentity,
      remoteToolCalls: this.#remoteToolCalls,
      remoteToolPriority,
      remoteMcpServers: this.#options.remoteMcpServers,
      turnClients: this.#turnClients,
      observeApprovalPolicy,
      rewriteClientMessages: this.#options.config !== null,
      threadListCwd:
        clientIdentity.clientSource === "vscode"
          ? (this.#options.config
              ? this.#options.controlDir
              : this.#options.localWorkspaceRoot)
          : undefined,
      threadListCwdProvider:
        clientIdentity.clientSource === "vscode" &&
        this.#options.localWorkspaceContextPath
          ? async () => {
              const workspaceRoot = await loadLocalWorkspaceContext(
                this.#options.localWorkspaceContextPath!,
              );
              if (workspaceRoot) {
                this.#setActiveWorkspaceRoot(workspaceRoot);
              }
              return workspaceRoot;
            }
          : undefined,
      spawnSsh: this.#options.spawnSsh,
    });
  }

  #downstreamWriter(sourceId: string, origin: RpcMessageWriter): RpcMessageWriter {
    return (message) => {
      if (!isRpcNotification(message)) {
        origin(message);
        return;
      }
      this.#broadcastNotification(sourceId, message);
    };
  }

  #broadcastNotification(sourceId: string, message: RpcMessage): void {
    const now = Date.now();
    const fingerprint = JSON.stringify(message);
    const recent = this.#relayedNotifications.get(fingerprint);
    if (recent && recent.expiresAtMs > now && !recent.sources.has(sourceId)) {
      recent.sources.add(sourceId);
      return;
    }

    this.#relayedNotifications.set(fingerprint, {
      expiresAtMs: now + NOTIFICATION_DEDUP_MS,
      sources: new Set([sourceId]),
    });
    if (this.#relayedNotifications.size > 256) {
      for (const [key, value] of this.#relayedNotifications) {
        if (value.expiresAtMs <= now) {
          this.#relayedNotifications.delete(key);
        }
      }
    }

    this.#stdioWriter?.(message);
    if (sourceId !== "stdio" && this.#stdioWriter) {
      this.#externalRelayCounts.set(
        sourceId,
        (this.#externalRelayCounts.get(sourceId) ?? 0) + 1,
      );
    }
    for (const writer of this.#externalWriters.values()) {
      writer(message);
    }
  }

  #observeClientMessage(
    message: ReturnType<typeof parseRpcLine>,
    pendingClientRequests: Map<RpcId, PendingClientRequest>,
    clientIdentity: BridgeClientIdentity,
  ): void {
    if (!isRpcRequest(message)) {
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (
      message.method === "thread/start" ||
      message.method === "thread/resume" ||
      message.method === "turn/start" ||
      message.method === "turn/steer"
    ) {
      pendingClientRequests.set(message.id, {
        clientIdentity: { ...clientIdentity },
        method: message.method,
        ...(typeof params.threadId === "string"
          ? { threadId: params.threadId }
          : {}),
        ...(typeof params.expectedTurnId === "string"
          ? { turnId: params.expectedTurnId }
          : {}),
      });
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      if (
        !this.#options.config &&
        typeof params.cwd === "string" &&
        isAbsolute(params.cwd)
      ) {
        this.#setActiveWorkspaceRoot(params.cwd);
      }
    }
  }

  #observeServerMessage(
    message: ReturnType<typeof parseRpcLine>,
    pendingClientRequests: Map<RpcId, PendingClientRequest>,
  ): void {
    if (isRpcResponse(message)) {
      const pending = pendingClientRequests.get(message.id);
      if (pending) {
        pendingClientRequests.delete(message.id);
        const result = isRecord(message.result) ? message.result : {};
        const thread = result.thread;
        if (isRecord(thread) && typeof thread.id === "string") {
          this.#setActiveThread(thread.id);
        }
        const turn = result.turn;
        if (
          pending.method === "turn/start" &&
          pending.threadId &&
          isRecord(turn) &&
          typeof turn.id === "string"
        ) {
          this.#turnClients.record(
            pending.threadId,
            turn.id,
            pending.clientIdentity,
          );
        }
        if (
          !message.error &&
          pending.method === "turn/steer" &&
          pending.threadId &&
          pending.turnId
        ) {
          this.#turnClients.record(
            pending.threadId,
            pending.turnId,
            pending.clientIdentity,
          );
        }
      }
      return;
    }
    if (!("method" in message) || !isRecord(message.params)) {
      return;
    }
    const thread = message.params.thread;
    if (isRecord(thread) && typeof thread.id === "string") {
      this.#setActiveThread(thread.id);
    }
    if (
      message.method === "turn/completed" &&
      typeof message.params.threadId === "string" &&
      isRecord(message.params.turn) &&
      typeof message.params.turn.id === "string"
    ) {
      this.#turnClients.complete(
        message.params.threadId,
        message.params.turn.id,
      );
    }
  }

  #observeExternalClientIdentity(
    message: ReturnType<typeof parseRpcLine>,
    clientIdentity: BridgeClientIdentity,
  ): void {
    if (
      !("method" in message) ||
      message.method !== "initialize" ||
      !isRecord(message.params) ||
      !isRecord(message.params.clientInfo)
    ) {
      return;
    }
    if (message.params.clientInfo.name === "codex_vscode_bridge_mcp") {
      clientIdentity.clientSource = "external-mcp";
    }
  }

  #externalRequestAuditDetails(
    message: ReturnType<typeof parseRpcLine>,
  ): Record<string, unknown> {
    if (!("method" in message)) {
      return {};
    }
    const details: Record<string, unknown> = { method: message.method };
    const params = isRecord(message.params) ? message.params : {};
    for (const key of ["threadId", "turnId", "expectedTurnId", "callId"] as const) {
      if (typeof params[key] === "string") {
        details[key] = params[key];
      }
    }
    return details;
  }

  #queueAudit(
    event: Omit<AuditEvent, "timestamp"> & { timestamp?: string },
  ): Promise<void> {
    this.#auditQueue = this.#auditQueue
      .catch(() => undefined)
      .then(() => this.#audit.write(event));
    return this.#auditQueue;
  }

  #setActiveThread(threadId: string): void {
    if (this.#activeThreadId === threadId) {
      return;
    }
    this.#activeThreadId = threadId;
    const address = this.#externalServer?.address();
    if (address && typeof address !== "string") {
      void this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${address.port}`);
    }
  }

  #setActiveWorkspaceRoot(workspaceRoot: string): void {
    if (this.#activeWorkspaceRoot === workspaceRoot) {
      return;
    }
    this.#activeWorkspaceRoot = workspaceRoot;
    const address = this.#externalServer?.address();
    if (address && typeof address !== "string") {
      void this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${address.port}`);
    }
  }

  async #writeDescriptor(endpoint: string): Promise<void> {
    const descriptor: ExternalCliSessionDescriptor = {
      version: 1,
      endpoint,
      host: this.#options.config?.host ?? "local",
      pid: process.pid,
      startedAtMs: this.#startedAtMs,
      tokenEnv: EXTERNAL_TOKEN_ENV,
      tokenPath: this.#externalTokenPath,
      workspaceRoot: this.#activeWorkspaceRoot,
      ...(this.#activeThreadId ? { threadId: this.#activeThreadId } : {}),
    };
    const temporaryPath = `${this.#sessionPath}.${randomBytes(6).toString("hex")}.tmp`;
    this.#descriptorQueue = this.#descriptorQueue.then(async () => {
      await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmodIfSupported(temporaryPath, 0o600);
      await rename(temporaryPath, this.#sessionPath);
    });
    await this.#descriptorQueue;
  }

  async #close(): Promise<void> {
    await this.#closeExternalClients();
    await Promise.allSettled([...this.#externalCleanupTasks]);
    this.#externalWriters.clear();
    this.#externalRelayCounts.clear();
    this.#stdioWriter = null;
    this.#relayedNotifications.clear();
    await new Promise<void>((resolvePromise) => {
      if (!this.#externalServer) {
        resolvePromise();
        return;
      }
      this.#externalServer.close(() => resolvePromise());
    });
    this.#externalServer = null;
    this.#child?.kill("SIGTERM");
    this.#child = null;
    await this.#descriptorQueue.catch(() => undefined);
    await this.#auditQueue.catch(() => undefined);
    await Promise.all([
      rm(this.#sessionPath, { force: true }),
      rm(this.#externalTokenPath, { force: true }),
      rm(this.#upstreamTokenPath, { force: true }),
    ]);
  }

  async #closeExternalClients(): Promise<void> {
    await Promise.all(
      [...(this.#externalServer?.clients ?? [])].map(
        (client) =>
          new Promise<void>((resolvePromise) => {
            if (client.readyState === WebSocket.CLOSED) {
              resolvePromise();
              return;
            }
            let timer: NodeJS.Timeout | undefined;
            const finish = (): void => {
              if (timer) {
                clearTimeout(timer);
              }
              resolvePromise();
            };
            client.once("close", finish);
            timer = setTimeout(() => {
              client.terminate();
              finish();
            }, EXTERNAL_CLOSE_GRACE_MS);
            if (client.readyState === WebSocket.OPEN) {
              client.close(EXTERNAL_CLOSE_CODE, EXTERNAL_CLOSE_REASON);
            }
          }),
      ),
    );
  }
}
