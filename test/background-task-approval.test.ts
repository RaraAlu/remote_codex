import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { TransportRequest } from "../src/core/vscode-transport.js";
import { ShimProxy } from "../src/shim/proxy.js";

async function observeThread(proxy: ShimProxy): Promise<void> {
  await proxy.handleClientMessage(
    {
      id: 1,
      method: "thread/start",
      params: { permissions: "workspace-write" },
    },
    () => undefined,
    () => undefined,
  );
  await proxy.handleServerMessage(
    {
      id: 1,
      result: { thread: { id: "thread-background" } },
    },
    () => undefined,
    () => undefined,
  );
}

describe("background task approval", () => {
  it("requires command approval before starting and records the decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-background-approval-"));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codex-background-approval-${process.pid}`
        : join(directory, "executor.sock");
    let observed: TransportRequest | undefined;
    const server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.once("line", (line) => {
        observed = JSON.parse(line) as TransportRequest;
        const taskId = String(observed.params.taskId);
        socket.end(
          `${JSON.stringify({
            id: observed.id,
            result: {
              taskId,
              status: "running",
              actualCwd: "/remote/workspace",
              startedAtMs: 10,
              completedAtMs: null,
              exitCode: null,
              signal: null,
              cancellationRequested: false,
              logBaseCursor: 0,
              logCursor: 0,
            },
            type: "response",
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const auditPath = join(directory, "audit.jsonl");
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/remote/workspace",
        connectionMode: "vscode-remote",
        remoteHelper: "vscode-extension",
        vscodeTransport: {
          endpoint,
          sessionId: "test-session",
          token: "0123456789abcdef0123456789abcdef",
        },
      }),
      controlDir: join(directory, "control"),
    });
    const clientMessages: Array<Record<string, unknown>> = [];
    const serverMessages: Array<Record<string, unknown>> = [];

    try {
      await observeThread(proxy);
      const running = proxy.handleServerMessage(
        {
          id: "tool-request",
          method: "item/tool/call",
          params: {
            arguments: {
              argv: ["sleep", "30"],
              cwd: ".",
              timeoutMs: 90_000,
            },
            callId: "background-item",
            threadId: "thread-background",
            tool: "remote_background_start",
            turnId: "turn-background",
          },
        },
        (message) => serverMessages.push(message as Record<string, unknown>),
        (message) => clientMessages.push(message as Record<string, unknown>),
      );
      await expect.poll(() => clientMessages.length).toBe(1);
      expect(clientMessages[0]).toMatchObject({
        method: "item/commandExecution/requestApproval",
        params: {
          command: "sleep 30",
          cwd: "/remote/workspace",
          itemId: "background-item",
        },
      });
      expect(observed).toBeUndefined();

      await proxy.handleClientMessage(
        {
          id: clientMessages[0]?.id as string,
          result: { decision: "accept" },
        },
        () => undefined,
        () => undefined,
      );
      await running;

      expect(observed).toMatchObject({
        operation: "backgroundStart",
        params: {
          argv: ["sleep", "30"],
          cwd: ".",
          timeoutMs: 90_000,
        },
      });
      expect(serverMessages).toHaveLength(1);
      expect(serverMessages[0]).toMatchObject({
        id: "tool-request",
        result: { success: true },
      });
      const audit = await readFile(auditPath, "utf8");
      expect(audit).toContain('"operation":"remote_background_start.approval"');
      expect(audit).toContain('"automatic":false');
      expect(audit).toContain('"decision":"accept"');
      expect(audit).toContain('"operation":"remote_background_start"');
    } finally {
      proxy.closeSession();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });
});
