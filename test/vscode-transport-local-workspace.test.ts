import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";

const mock = vi.hoisted(() => ({
  executeCommand: vi.fn(async () => {
    throw new Error("local workspace requests must not reach the Remote Executor");
  }),
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
  mock.executeCommand.mockClear();
});

describe("VS Code Controller workspace transport", () => {
  it("authenticates and handles local requests without forwarding them remotely", async () => {
    const config = parseBridgeConfig({
      host: "remote-host",
      workspaceRoot: "/remote/workspace",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
      commandTimeoutMs: 12_345,
      maxOutputBytes: 65_536,
    });
    const handler = vi.fn(async () => ({ canonicalPath: "/local/reference/notes.md" }));
    transport = new VsCodeTransportServer(() => config, handler);
    const descriptor = await transport.start();
    const socket = createConnection(descriptor.endpoint);
    const lines = createInterface({ input: socket });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const response = new Promise<Record<string, unknown>>((resolve) => {
      lines.once("line", (line) => resolve(JSON.parse(line) as Record<string, unknown>));
    });

    socket.write(
      `${JSON.stringify({
        hostId: config.host,
        id: "local-request",
        operation: "localReadFile",
        outputCommand: "untrusted",
        params: {
          path: "notes.md",
          rootId: "local-reference",
          threadId: "thread-1",
        },
        policy: {
          commandTimeoutMs: 999_999,
          maxOutputBytes: 999_999,
        },
        token: descriptor.token,
        workspaceRoot: config.workspaceRoot,
      })}\n`,
    );

    await expect(response).resolves.toEqual({
      id: "local-request",
      result: { canonicalPath: "/local/reference/notes.md" },
      type: "response",
    });
    expect(handler).toHaveBeenCalledWith({
      hostId: config.host,
      id: "local-request",
      operation: "localReadFile",
      params: {
        path: "notes.md",
        rootId: "local-reference",
        threadId: "thread-1",
      },
      policy: {
        commandTimeoutMs: 12_345,
        maxOutputBytes: 65_536,
      },
      workspaceRoot: config.workspaceRoot,
    });
    expect(mock.executeCommand).not.toHaveBeenCalled();

    lines.close();
    socket.destroy();
  });

  it.each([
    "openWorkspaceResource",
    "registerWorkspaceResource",
    "showWorkspaceDiff",
  ] as const)(
    "routes %s to the Controller without invoking the Remote Executor",
    async (operation) => {
      const config = parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/remote/workspace",
        connectionMode: "vscode-remote",
        remoteHelper: "vscode-extension",
      });
      const handler = vi.fn(async () => ({ action: operation }));
      transport = new VsCodeTransportServer(() => config, handler);
      const descriptor = await transport.start();
      const socket = createConnection(descriptor.endpoint);
      const lines = createInterface({ input: socket });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const response = new Promise<Record<string, unknown>>((resolve) => {
        lines.once("line", (line) => resolve(JSON.parse(line) as Record<string, unknown>));
      });

      socket.write(
        `${JSON.stringify({
          hostId: config.host,
          id: `resource-${operation}`,
          operation,
          outputCommand: "untrusted",
          params: {
            path: "/remote/workspace/src/main.ts",
            rootId: "remote-primary",
          },
          policy: {
            commandTimeoutMs: config.commandTimeoutMs,
            maxOutputBytes: config.maxOutputBytes,
          },
          token: descriptor.token,
          workspaceRoot: config.workspaceRoot,
        })}\n`,
      );

      await expect(response).resolves.toEqual({
        id: `resource-${operation}`,
        result: { action: operation },
        type: "response",
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ operation }),
      );
      expect(mock.executeCommand).not.toHaveBeenCalled();

      lines.close();
      socket.destroy();
    },
  );
});
