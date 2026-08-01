import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { asBridgeError, BridgeError } from "../core/errors.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import { bridgeStateDir } from "../core/locations.js";
import type { BridgeConfig, VsCodeTransportDescriptor } from "../core/types.js";
import {
  isControllerWorkspaceOperation,
  isRemoteExecutionAccepted,
  isRemoteExecutionCompletedEvent,
  isRemoteOutputEvent,
  isRemoteStdioEvent,
  isTransportStdioInput,
  isTransportRequest,
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_OUTPUT_COMMAND,
  type ControllerWorkspaceRequest,
  type RemoteExecutorCommandRequest,
  type RemoteExecutorCommandResponse,
  type RemoteExecutionCompletedEvent,
  type RemoteOutputEvent,
  type RemoteStdioEvent,
  type TransportMessage,
} from "../core/vscode-transport.js";

export type ControllerWorkspaceHandler = (
  request: ControllerWorkspaceRequest,
) => Promise<unknown>;

interface StdioSocket {
  request: RemoteExecutorCommandRequest;
  socket: Socket;
}

interface ActiveRemoteRequest {
  commandAckMs: number | null;
  firstOutputMs?: number;
  outputEvents: number;
  request: RemoteExecutorCommandRequest;
  socket: Socket;
  startedAt: number;
}

function transportEndpoint(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codex-remote-bridge-${sessionId}`;
  }
  return join(bridgeStateDir(), "sockets", `${sessionId}.sock`);
}

function writeMessage(socket: Socket, message: TransportMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function tokenMatches(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export class VsCodeTransportServer implements vscode.Disposable {
  readonly #config: () => BridgeConfig | null;
  readonly #controllerWorkspace: ControllerWorkspaceHandler | null;
  readonly #activeRemoteRequests = new Map<string, ActiveRemoteRequest>();
  readonly #pending = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  readonly #stdioSockets = new Map<string, StdioSocket>();
  #descriptor: VsCodeTransportDescriptor | null = null;
  #server: Server | null = null;
  #starting: Promise<VsCodeTransportDescriptor> | null = null;

  constructor(
    config: () => BridgeConfig | null,
    controllerWorkspace: ControllerWorkspaceHandler | null = null,
  ) {
    this.#config = config;
    this.#controllerWorkspace = controllerWorkspace;
  }

  async start(): Promise<VsCodeTransportDescriptor> {
    if (this.#descriptor) {
      return this.#descriptor;
    }
    if (this.#starting) {
      return await this.#starting;
    }
    const task = this.#startOnce();
    this.#starting = task;
    try {
      return await task;
    } finally {
      if (this.#starting === task) {
        this.#starting = null;
      }
    }
  }

  handleOutput(value: unknown): void {
    if (isRemoteStdioEvent(value)) {
      this.#handleStdioOutput(value);
      return;
    }
    if (isRemoteExecutionCompletedEvent(value)) {
      this.#handleExecutionCompleted(value);
      return;
    }
    if (!isRemoteOutputEvent(value)) {
      return;
    }
    const socket = this.#pending.get(value.id);
    if (!socket || socket.destroyed) {
      return;
    }
    const active = this.#activeRemoteRequests.get(value.id);
    if (active) {
      active.outputEvents += 1;
      active.firstOutputMs ??= Math.round(performance.now() - active.startedAt);
    }
    writeMessage(socket, { ...value, type: "output" });
  }

  async close(): Promise<void> {
    const endpoint = this.#descriptor?.endpoint;
    await Promise.allSettled(
      [...this.#activeRemoteRequests.values()].map(({ request }) =>
        this.#cancelRemoteOperation(request),
      ),
    );
    this.#activeRemoteRequests.clear();
    await Promise.allSettled(
      [...this.#stdioSockets.values()].map(({ request }) =>
        this.#sendStdioControl(request, "stdioStop", {}),
      ),
    );
    this.#stdioSockets.clear();
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    this.#pending.clear();
    const server = this.#server;
    this.#server = null;
    this.#descriptor = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (endpoint && process.platform !== "win32") {
      await rm(endpoint, { force: true });
    }
  }

  dispose(): void {
    void this.close();
  }

  async #startOnce(): Promise<VsCodeTransportDescriptor> {
    const sessionId = `${process.pid}-${randomUUID()}`;
    const endpoint = transportEndpoint(sessionId);
    const descriptor: VsCodeTransportDescriptor = {
      endpoint,
      sessionId,
      token: randomBytes(32).toString("base64url"),
    };
    if (process.platform !== "win32") {
      await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      await chmodIfSupported(dirname(endpoint), 0o700);
      await rm(endpoint, { force: true });
    }
    const server = createServer((socket) => this.#accept(socket, descriptor));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(endpoint, () => {
        server.off("error", onError);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      await chmodIfSupported(endpoint, 0o600);
    }
    this.#server = server;
    this.#descriptor = descriptor;
    return descriptor;
  }

  #accept(socket: Socket, descriptor: VsCodeTransportDescriptor): void {
    this.#sockets.add(socket);
    const lines = createInterface({ input: socket });
    let initialRequestHandled = false;
    let stdioRequest: RemoteExecutorCommandRequest | null = null;
    let inputQueue = Promise.resolve();
    const cleanup = (): void => {
      lines.close();
      this.#sockets.delete(socket);
      for (const [id, pendingSocket] of this.#pending) {
        if (pendingSocket === socket) {
          this.#pending.delete(id);
        }
      }
      for (const [id, active] of this.#activeRemoteRequests) {
        if (active.socket === socket) {
          this.#activeRemoteRequests.delete(id);
          void this.#cancelRemoteOperation(active.request).catch(() => undefined);
        }
      }
      for (const [id, session] of this.#stdioSockets) {
        if (session.socket === socket) {
          this.#stdioSockets.delete(id);
          void this.#sendStdioControl(session.request, "stdioStop", {}).catch(() => undefined);
        }
      }
    };
    socket.once("close", cleanup);
    socket.once("error", () => cleanup());
    lines.on("line", (line) => {
      if (!initialRequestHandled) {
        initialRequestHandled = true;
        void this.#handleLine(line, socket, descriptor).then((request) => {
          if (request?.operation === "stdioStart") {
            stdioRequest = request;
          } else if (!request) {
            socket.end();
          }
        });
        return;
      }
      if (!stdioRequest) {
        socket.destroy();
        return;
      }
      inputQueue = inputQueue
        .then(() => this.#handleStdioInput(line, stdioRequest as RemoteExecutorCommandRequest))
        .catch((error) => {
          writeMessage(socket, {
            error: asBridgeError(error, "REMOTE_TRANSPORT_DISCONNECTED").toPayload(),
            id: stdioRequest?.id ?? "unknown",
            type: "response",
          });
          socket.end();
        });
    });
  }

  async #handleLine(
    line: string,
    socket: Socket,
    descriptor: VsCodeTransportDescriptor,
  ): Promise<RemoteExecutorCommandRequest | null> {
    let id = "unknown";
    let keepOpen = false;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isTransportRequest(parsed)) {
        throw new BridgeError("PROTOCOL_MISMATCH", "Invalid VS Code transport request");
      }
      id = parsed.id;
      if (!tokenMatches(descriptor.token, parsed.token)) {
        throw new BridgeError("COMMAND_DENIED", "VS Code transport authentication failed");
      }
      const config = this.#config();
      if (
        !config ||
        config.connectionMode !== "vscode-remote" ||
        parsed.hostId !== config.host ||
        parsed.workspaceRoot !== config.workspaceRoot
      ) {
        throw new BridgeError(
          "REMOTE_TRANSPORT_DISCONNECTED",
          "VS Code transport request does not match the active remote workspace",
        );
      }
      if (this.#pending.has(id)) {
        throw new BridgeError("PROTOCOL_MISMATCH", "Duplicate VS Code transport request id");
      }
      this.#pending.set(id, socket);
      const policy = {
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      };
      if (isControllerWorkspaceOperation(parsed.operation)) {
        if (!this.#controllerWorkspace) {
          throw new BridgeError(
            "COMMAND_DENIED",
            "Controller workspace execution is unavailable",
          );
        }
        const result = await this.#controllerWorkspace({
          hostId: parsed.hostId,
          id,
          operation: parsed.operation,
          params: parsed.params,
          policy,
          workspaceRoot: parsed.workspaceRoot,
        });
        writeMessage(socket, { id, result, type: "response" });
        return null;
      }
      const request: RemoteExecutorCommandRequest = {
        hostId: parsed.hostId,
        id,
        operation: parsed.operation,
        outputCommand: REMOTE_OUTPUT_COMMAND,
        params: parsed.params,
        policy,
        workspaceRoot: parsed.workspaceRoot,
      };
      if (request.operation === "stdioStart") {
        this.#stdioSockets.set(id, { request, socket });
      }
      if (request.operation === "execute") {
        this.#activeRemoteRequests.set(id, {
          commandAckMs: null,
          outputEvents: 0,
          request,
          socket,
          startedAt: performance.now(),
        });
      }
      const response = await vscode.commands.executeCommand<RemoteExecutorCommandResponse>(
        REMOTE_EXECUTOR_COMMAND,
        request,
      );
      if (!response || typeof response.ok !== "boolean") {
        throw new BridgeError(
          "REMOTE_TRANSPORT_DISCONNECTED",
          "Remote Executor extension is unavailable in the current Remote SSH window",
        );
      }
      if (request.operation === "execute" && response.ok) {
        const active = this.#activeRemoteRequests.get(id);
        if (active) {
          active.commandAckMs = Math.round(performance.now() - active.startedAt);
        }
        if (!isRemoteExecutionAccepted(response.result)) {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "Remote Executor did not acknowledge the asynchronous execute protocol",
          );
        }
        keepOpen = true;
        return request;
      }
      if (response.ok) {
        if (request.operation === "stdioStart") {
          writeMessage(socket, { id, type: "stdioReady" });
          return request;
        }
        writeMessage(socket, { id, result: response.result, type: "response" });
      } else {
        writeMessage(socket, { error: response.error, id, type: "response" });
      }
    } catch (error) {
      writeMessage(socket, {
        error: asBridgeError(error, "REMOTE_TRANSPORT_DISCONNECTED").toPayload(),
        id,
        type: "response",
      });
    } finally {
      if (!keepOpen) {
        this.#activeRemoteRequests.delete(id);
        this.#pending.delete(id);
      }
    }
    this.#stdioSockets.delete(id);
    return null;
  }

  async #handleStdioInput(
    line: string,
    request: RemoteExecutorCommandRequest,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Invalid remote stdio input frame", undefined, {
        cause: error,
      });
    }
    if (!isTransportStdioInput(parsed) || parsed.id !== request.id) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Mismatched remote stdio input frame");
    }
    await this.#sendStdioControl(
      request,
      parsed.type === "stdioInput" ? "stdioWrite" : "stdioEnd",
      parsed.type === "stdioInput" ? { chunk: parsed.chunk } : {},
    );
  }

  async #sendStdioControl(
    request: RemoteExecutorCommandRequest,
    operation: "stdioEnd" | "stdioStop" | "stdioWrite",
    params: Record<string, unknown>,
  ): Promise<void> {
    const response = await vscode.commands.executeCommand<RemoteExecutorCommandResponse>(
      REMOTE_EXECUTOR_COMMAND,
      { ...request, operation, params },
    );
    if (!response?.ok) {
      const code = response?.error?.code;
      throw new BridgeError(
        code ?? "REMOTE_TRANSPORT_DISCONNECTED",
        response?.error?.message ?? "Remote stdio control request failed",
        response?.error?.details,
      );
    }
  }

  async #cancelRemoteOperation(request: RemoteExecutorCommandRequest): Promise<void> {
    const response = await vscode.commands.executeCommand<RemoteExecutorCommandResponse>(
      REMOTE_EXECUTOR_COMMAND,
      {
        ...request,
        id: `${request.id}:cancel`,
        operation: "cancel",
        params: { operationId: request.id },
      },
    );
    if (!response?.ok) {
      throw new BridgeError(
        response?.error?.code ?? "REMOTE_TRANSPORT_DISCONNECTED",
        response?.error?.message ?? "Remote operation cancellation failed",
        response?.error?.details,
      );
    }
  }

  #handleStdioOutput(event: RemoteStdioEvent): void {
    const session = this.#stdioSockets.get(event.id);
    if (!session || session.socket.destroyed) {
      return;
    }
    if (event.event === "data") {
      writeMessage(session.socket, {
        channel: event.channel,
        chunk: event.chunk,
        id: event.id,
        type: "stdioOutput",
      });
      return;
    }
    this.#stdioSockets.delete(event.id);
    writeMessage(session.socket, {
      exitCode: event.exitCode,
      id: event.id,
      signal: event.signal,
      type: "stdioExit",
    });
    session.socket.end();
  }

  #handleExecutionCompleted(event: RemoteExecutionCompletedEvent): void {
    const active = this.#activeRemoteRequests.get(event.id);
    if (!active || active.socket.destroyed) {
      return;
    }
    const timing = {
      controllerCommandAckMs: active.commandAckMs,
      controllerCompletionMs: Math.round(performance.now() - active.startedAt),
      ...(active.firstOutputMs === undefined
        ? {}
        : { controllerFirstOutputMs: active.firstOutputMs }),
      controllerOutputEvents: active.outputEvents,
    };
    const response = event.response.ok
      ? {
          ...event.response,
          result:
            event.response.result &&
            typeof event.response.result === "object" &&
            !Array.isArray(event.response.result)
              ? { ...event.response.result, transportTiming: timing }
              : event.response.result,
        }
      : {
          ...event.response,
          error: event.response.error
            ? {
                ...event.response.error,
                details: { ...event.response.error.details, transportTiming: timing },
              }
            : event.response.error,
        };
    this.#activeRemoteRequests.delete(event.id);
    this.#pending.delete(event.id);
    writeMessage(active.socket, {
      ...(response.error ? { error: response.error } : {}),
      id: event.id,
      ...(response.result === undefined ? {} : { result: response.result }),
      type: "response",
    });
    active.socket.end();
  }
}
