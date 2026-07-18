import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  type RemoteExecutorCommandRequest,
  type RemoteStdioEvent,
  type TransportMessage,
} from "../src/core/vscode-transport.js";

const mock = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: mock.executeCommand,
  },
}));

import { VsCodeTransportServer } from "../src/extension/vscode-transport-server.js";

let transport: VsCodeTransportServer | null = null;

afterEach(async () => {
  await transport?.close();
  transport = null;
  mock.executeCommand.mockReset();
});

describe("VsCodeTransportServer remote stdio", () => {
  it("translates one persistent authenticated socket into remote stdio commands", async () => {
    const config = parseBridgeConfig({
      host: "remote-host",
      workspaceRoot: "/workspace",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
    });
    transport = new VsCodeTransportServer(() => config);
    const descriptor = await transport.start();
    const operations: RemoteExecutorCommandRequest[] = [];
    mock.executeCommand.mockImplementation(
      async (command: string, request: RemoteExecutorCommandRequest) => {
        expect(command).toBe(REMOTE_EXECUTOR_COMMAND);
        operations.push(request);
        if (request.operation === "stdioWrite") {
          expect(Buffer.from(String(request.params.chunk), "base64").toString()).toBe(
            "request\n",
          );
        }
        if (request.operation === "stdioEnd") {
          transport?.handleOutput({
            channel: "stdout",
            chunk: Buffer.from("response\n").toString("base64"),
            event: "data",
            id: request.id,
          } satisfies RemoteStdioEvent);
          transport?.handleOutput({
            event: "exit",
            exitCode: 0,
            id: request.id,
            signal: null,
          } satisfies RemoteStdioEvent);
        }
        return { ok: true, result: {} };
      },
    );

    const messages: TransportMessage[] = [];
    const socket = createConnection(descriptor.endpoint);
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => messages.push(JSON.parse(line) as TransportMessage));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const id = "stdio-session";
    socket.write(
      `${JSON.stringify({
        hostId: config.host,
        id,
        operation: "stdioStart",
        outputCommand: "ignored-by-controller",
        params: { args: ["serve", "--mcp"], executable: "index-mcp" },
        policy: {
          commandTimeoutMs: config.commandTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
        },
        token: descriptor.token,
        workspaceRoot: config.workspaceRoot,
      })}\n`,
    );
    await vi.waitFor(() => expect(messages).toContainEqual({ id, type: "stdioReady" }));

    socket.write(
      `${JSON.stringify({
        chunk: Buffer.from("request\n").toString("base64"),
        id,
        type: "stdioInput",
      })}\n`,
    );
    socket.write(`${JSON.stringify({ id, type: "stdioEnd" })}\n`);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({ exitCode: 0, id, signal: null, type: "stdioExit" }),
    );
    expect(messages).toContainEqual({
      channel: "stdout",
      chunk: Buffer.from("response\n").toString("base64"),
      id,
      type: "stdioOutput",
    });
    expect(operations.map((request) => request.operation)).toEqual([
      "stdioStart",
      "stdioWrite",
      "stdioEnd",
    ]);
    expect(operations[0]).toMatchObject({
      outputCommand: "codexRemoteBridge.transport.output",
      params: { args: ["serve", "--mcp"], executable: "index-mcp" },
    });

    lines.close();
    socket.destroy();
  });
});
