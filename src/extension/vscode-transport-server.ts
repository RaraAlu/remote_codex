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
  isRemoteOutputEvent,
  isTransportRequest,
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_OUTPUT_COMMAND,
  type RemoteExecutorCommandRequest,
  type RemoteExecutorCommandResponse,
  type RemoteOutputEvent,
  type TransportMessage,
} from "../core/vscode-transport.js";

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
  readonly #pending = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  #descriptor: VsCodeTransportDescriptor | null = null;
  #server: Server | null = null;
  #starting: Promise<VsCodeTransportDescriptor> | null = null;

  constructor(config: () => BridgeConfig | null) {
    this.#config = config;
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
    if (!isRemoteOutputEvent(value)) {
      return;
    }
    const socket = this.#pending.get(value.id);
    if (!socket || socket.destroyed) {
      return;
    }
    writeMessage(socket, { ...value, type: "output" });
  }

  async close(): Promise<void> {
    const endpoint = this.#descriptor?.endpoint;
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
    let handled = false;
    const cleanup = (): void => {
      lines.close();
      this.#sockets.delete(socket);
      for (const [id, pendingSocket] of this.#pending) {
        if (pendingSocket === socket) {
          this.#pending.delete(id);
        }
      }
    };
    socket.once("close", cleanup);
    socket.once("error", () => cleanup());
    lines.on("line", (line) => {
      if (handled) {
        socket.destroy();
        return;
      }
      handled = true;
      void this.#handleLine(line, socket, descriptor).finally(() => socket.end());
    });
  }

  async #handleLine(
    line: string,
    socket: Socket,
    descriptor: VsCodeTransportDescriptor,
  ): Promise<void> {
    let id = "unknown";
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
      const request: RemoteExecutorCommandRequest = {
        hostId: parsed.hostId,
        id,
        operation: parsed.operation,
        outputCommand: REMOTE_OUTPUT_COMMAND,
        params: parsed.params,
        policy: {
          commandTimeoutMs: config.commandTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
        },
        workspaceRoot: parsed.workspaceRoot,
      };
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
      if (response.ok) {
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
      this.#pending.delete(id);
    }
  }
}
