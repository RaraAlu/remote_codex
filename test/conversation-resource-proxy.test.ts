import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { TransportRequest } from "../src/core/vscode-transport.js";
import { ShimProxy } from "../src/shim/proxy.js";
import type { RpcMessage } from "../src/shim/rpc.js";

describe("conversation resource proxy", () => {
  it("binds a dropped mention to one thread without adding a secondary root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-conversation-resource-"));
    const endpoint =
      process.platform === "win32"
        ? `\\.\pipe\codex-conversation-resource-${process.pid}`
        : join(directory, "controller.sock");
    const observed: TransportRequest[] = [];
    const server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.once("line", (line) => {
        const request = JSON.parse(line) as TransportRequest;
        observed.push(request);
        const result =
          request.operation === "resolveConversationResources"
            ? [
                {
                  id: "context-reference",
                  target: "local",
                  role: "conversation",
                  kind: "directory",
                  path: "/local/reference",
                  displayName: "reference",
                  threadId: "thread-1",
                },
              ]
            : request.operation === "deleteConversationResources"
              ? { deleted: true }
              : null;
        socket.end(
          `${JSON.stringify({ id: request.id, result, type: "response" })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });

    const config = parseBridgeConfig({
      connectionMode: "vscode-remote",
      host: "remote-host",
      remoteHelper: "vscode-extension",
      vscodeTransport: {
        endpoint,
        sessionId: "test-session",
        token: "0123456789abcdef0123456789abcdef",
      },
      workspaceRoot: "/remote/workspace",
    });
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config,
      controlDir: join(directory, "control"),
    });
    const forwarded: RpcMessage[] = [];
    const rejected: RpcMessage[] = [];
    const clientMessages: RpcMessage[] = [];

    try {
      await proxy.handleClientMessage(
        {
          id: "turn-1",
          method: "turn/start",
          params: {
            threadId: "thread-1",
            input: [{ type: "mention", path: "/local/reference" }],
          },
        },
        (message) => forwarded.push(message as RpcMessage),
        (message) => rejected.push(message as RpcMessage),
      );
      await proxy.handleClientMessage(
        {
          id: "delete-1",
          method: "thread/delete",
          params: { threadId: "thread-1" },
        },
        (message) => forwarded.push(message as RpcMessage),
        (message) => rejected.push(message as RpcMessage),
      );
      await proxy.handleServerMessage(
        { id: "delete-1", result: {} },
        () => undefined,
        (message) => clientMessages.push(message as RpcMessage),
      );
    } finally {
      proxy.closeSession();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }

    expect(rejected).toEqual([]);
    expect(observed).toHaveLength(3);
    expect(observed[0]).toMatchObject({
      operation: "resolveConversationResources",
      params: {
        mentionPaths: ["/local/reference"],
        rootId: "remote-primary",
        threadId: "thread-1",
      },
    });
    expect(observed[1]).toMatchObject({ operation: "resolveEditorContext" });
    expect(observed[2]).toMatchObject({
      operation: "deleteConversationResources",
      params: { rootId: "remote-primary", threadId: "thread-1" },
    });
    expect(config.roots).toEqual([
      expect.objectContaining({
        id: "remote-primary",
        role: "primary",
        target: "remote",
      }),
    ]);
    expect(forwarded).toHaveLength(2);
    expect(clientMessages).toEqual([{ id: "delete-1", result: {} }]);
    const context = JSON.stringify(
      (forwarded[0] as { params: Record<string, unknown> }).params.additionalContext,
    );
    expect(context).toContain(
      "Local resources explicitly shared with this conversation",
    );
    expect(context).toContain("context-reference");
    expect(context).toContain("/local/reference");
  });
});
