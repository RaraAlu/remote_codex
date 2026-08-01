import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_OUTPUT_COMMAND,
  type RemoteExecutorCommandRequest,
} from "../src/core/vscode-transport.js";

const mock = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock("vscode", () => ({
  commands: { executeCommand: mock.executeCommand },
}));

import { VsCodeTransportServer } from "../src/extension/vscode-transport-server.js";

let transport: VsCodeTransportServer | null = null;

afterEach(async () => {
  await transport?.close();
  transport = null;
  mock.executeCommand.mockReset();
});

describe("VS Code Controller asynchronous execute transport", () => {
  it("releases the cross-host command before streaming output and completion", async () => {
    const config = parseBridgeConfig({
      host: "remote-host",
      workspaceRoot: "/workspace",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
    });
    transport = new VsCodeTransportServer(() => config);
    const descriptor = await transport.start();
    mock.executeCommand.mockImplementation(
      async (command: string, request: RemoteExecutorCommandRequest) => {
        expect(command).toBe(REMOTE_EXECUTOR_COMMAND);
        expect(request).toMatchObject({
          id: "execute-1",
          operation: "execute",
          outputCommand: REMOTE_OUTPUT_COMMAND,
        });
        return { ok: true, result: { accepted: true } };
      },
    );

    const socket = createConnection(descriptor.endpoint);
    const received: Array<Record<string, unknown>> = [];
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) {
          break;
        }
        received.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        buffered = buffered.slice(newline + 1);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({
        hostId: config.host,
        id: "execute-1",
        operation: "execute",
        outputCommand: "untrusted",
        params: {
          argv: ["printf", "ready"],
          idempotencyKey: "execute-key",
          options: { sideEffect: true },
        },
        policy: {
          commandTimeoutMs: config.commandTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
        },
        token: descriptor.token,
        workspaceRoot: config.workspaceRoot,
      })}\n`,
    );
    await vi.waitFor(() => expect(mock.executeCommand).toHaveBeenCalledTimes(1));
    expect(received).toEqual([]);

    transport.handleOutput({
      channel: "stdout",
      chunk: "ready",
      id: "execute-1",
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      channel: "stdout",
      chunk: "ready",
      id: "execute-1",
      type: "output",
    });

    transport.handleOutput({
      event: "executionComplete",
      id: "execute-1",
      response: {
        ok: true,
        result: {
          actualCwd: "/workspace",
          durationMs: 11,
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "ready",
          truncated: false,
        },
      },
    });
    await new Promise<void>((resolve) => socket.once("end", resolve));

    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      id: "execute-1",
      result: {
        durationMs: 11,
        transportTiming: {
          controllerCommandAckMs: expect.any(Number),
          controllerCompletionMs: expect.any(Number),
          controllerFirstOutputMs: expect.any(Number),
          controllerOutputEvents: 1,
        },
      },
      type: "response",
    });
    expect(mock.executeCommand).toHaveBeenCalledTimes(1);
    socket.destroy();
  });
});
