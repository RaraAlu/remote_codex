import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { VsCodeRemoteExecutor } from "../src/core/vscode-remote-executor.js";
import type { TransportRequest } from "../src/core/vscode-transport.js";

let server: Server | null = null;
let endpoint: string | null = null;

async function listen(
  respond: (
    request: TransportRequest,
    write: (message: unknown) => void,
    disconnect: () => void,
  ) => void,
): Promise<string> {
  const id = randomUUID();
  endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codex-bridge-test-${id}`
      : join(tmpdir(), `codex-bridge-test-${id}.sock`);
  if (process.platform !== "win32") {
    await mkdir(tmpdir(), { recursive: true });
    await rm(endpoint, { force: true });
  }
  server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.once("line", (line) => {
      const request = JSON.parse(line) as TransportRequest;
      respond(
        request,
        (message) => socket.write(`${JSON.stringify(message)}\n`),
        () => socket.end(),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(endpoint as string, resolve);
  });
  return endpoint;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  if (endpoint && process.platform !== "win32") {
    await rm(endpoint, { force: true });
  }
  server = null;
  endpoint = null;
});

function config(pipe: string) {
  return parseBridgeConfig({
    host: "remote-host",
    workspaceRoot: "/workspace",
    connectionMode: "vscode-remote",
    remoteHelper: "vscode-extension",
    vscodeTransport: {
      endpoint: pipe,
      sessionId: "test-session",
      token: "0123456789abcdef0123456789abcdef",
    },
  });
}

describe("VsCodeRemoteExecutor", () => {
  it("streams output and returns structured results over the local transport", async () => {
    let observed: TransportRequest | undefined;
    const pipe = await listen((request, write) => {
      observed = request;
      write({ channel: "stdout", chunk: "streamed", id: request.id, type: "output" });
      write({
        id: request.id,
        result: {
          actualCwd: "/workspace",
          durationMs: 3,
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "done",
          truncated: false,
        },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));
    const streamed: string[] = [];

    await expect(
      executor.execute(["printf", "done"], {
        idempotencyKey: "stable-operation",
        onStdout: (chunk) => streamed.push(chunk),
        stdin: Buffer.from("input"),
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "done" });
    expect(streamed).toEqual(["streamed"]);
    expect(observed).toMatchObject({
      hostId: "remote-host",
      operation: "execute",
      params: {
        idempotencyKey: "stable-operation",
        options: { stdinBase64: "aW5wdXQ=" },
      },
      token: "0123456789abcdef0123456789abcdef",
      workspaceRoot: "/workspace",
    });
    executor.close();
  });

  it("routes an authorized local workspace request through the Controller transport", async () => {
    let observed: TransportRequest | undefined;
    const pipe = await listen((request, write) => {
      observed = request;
      write({
        id: request.id,
        result: { canonicalPath: "/local/reference/notes.md" },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(
      executor.requestControllerWorkspace(
        "localReadFile",
        "local-reference",
        { path: "notes.md" },
      ),
    ).resolves.toEqual({ canonicalPath: "/local/reference/notes.md" });
    expect(observed).toMatchObject({
      operation: "localReadFile",
      params: {
        path: "notes.md",
        rootId: "local-reference",
      },
    });
    executor.close();
  });

  it("preserves Bridge errors returned by the remote executor", async () => {
    const pipe = await listen((request, write) => {
      write({
        error: {
          code: "PATH_OUTSIDE_ROOT",
          message: "outside",
          retryable: false,
        },
        id: request.id,
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));
    await expect(executor.canonicalPath("../outside")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
      message: "outside",
    });
    executor.close();
  });

  it("queries the result ledger by idempotency key", async () => {
    let observed: TransportRequest | undefined;
    const pipe = await listen((request, write) => {
      observed = request;
      write({
        id: request.id,
        result: {
          result: {
            actualCwd: "/workspace",
            durationMs: 3,
            exitCode: 0,
            signal: null,
            stderr: "",
            stdout: "done",
            truncated: false,
          },
          status: "completed",
        },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(executor.operationStatus("stable-operation")).resolves.toMatchObject({
      result: { exitCode: 0, stdout: "done" },
      status: "completed",
    });
    expect(observed).toMatchObject({
      operation: "resultStatus",
      params: { idempotencyKey: "stable-operation" },
    });
    executor.close();
  });

  it("requests deterministic cleanup for the current remote workspace", async () => {
    let observed: TransportRequest | undefined;
    const pipe = await listen((request, write) => {
      observed = request;
      write({
        id: request.id,
        result: {
          backgroundTasks: 2,
          operations: 1,
          stdioSessions: 1,
        },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(executor.stopWorkspace()).resolves.toEqual({
      backgroundTasks: 2,
      operations: 1,
      stdioSessions: 1,
    });
    expect(observed).toMatchObject({
      operation: "workspaceStop",
      params: {},
    });
    executor.close();
  });

  it("recovers a completed side effect from the result ledger after disconnect", async () => {
    const operations: TransportRequest[] = [];
    let statusRequests = 0;
    const pipe = await listen((request, write, disconnect) => {
      operations.push(request);
      if (request.operation === "execute") {
        disconnect();
        return;
      }
      expect(request).toMatchObject({
        operation: "resultStatus",
        params: { idempotencyKey: "recover-completed" },
      });
      statusRequests += 1;
      if (statusRequests === 1) {
        disconnect();
        return;
      }
      write({
        id: request.id,
        result: {
          result: {
            actualCwd: "/workspace",
            durationMs: 3,
            exitCode: 0,
            signal: null,
            stderr: "",
            stdout: "done",
            truncated: false,
          },
          status: "completed",
        },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(
      executor.execute(["printf", "done"], {
        idempotencyKey: "recover-completed",
        sideEffect: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      idempotencyOutcome: "replayed",
      stdout: "done",
    });
    expect(operations.map((request) => request.operation)).toEqual([
      "execute",
      "resultStatus",
      "resultStatus",
    ]);
    executor.close();
  });

  it("polls a running operation and preserves its terminal error", async () => {
    let statusRequests = 0;
    const operations: string[] = [];
    const pipe = await listen((request, write, disconnect) => {
      operations.push(request.operation);
      if (request.operation === "execute") {
        disconnect();
        return;
      }
      statusRequests += 1;
      write({
        id: request.id,
        result:
          statusRequests === 1
            ? { status: "running" }
            : {
                error: {
                  code: "TIMEOUT",
                  message: "remote command timed out",
                  retryable: false,
                },
                status: "failed",
              },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(
      executor.execute(["sleep", "30"], {
        idempotencyKey: "recover-failed",
        sideEffect: true,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      details: {
        idempotencyOutcome: "replayed",
        recoveryAttempts: 2,
      },
    });
    expect(operations).toEqual(["execute", "resultStatus", "resultStatus"]);
    executor.close();
  });

  it("does not replay a side effect when the result ledger is unknown", async () => {
    const operations: string[] = [];
    const pipe = await listen((request, write, disconnect) => {
      operations.push(request.operation);
      if (request.operation === "execute") {
        disconnect();
        return;
      }
      write({
        id: request.id,
        result: { status: "unknown" },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(
      executor.execute(["touch", "unsafe"], {
        idempotencyKey: "recover-unknown",
        sideEffect: true,
      }),
    ).rejects.toMatchObject({
      code: "RESULT_UNKNOWN",
      details: {
        idempotencyKey: "recover-unknown",
        recoveryAttempts: 1,
        recoveryStatus: "unknown",
      },
    });
    expect(operations).toEqual(["execute", "resultStatus"]);
    executor.close();
  });

  it("sends an explicit cancel request and waits for remote cancellation", async () => {
    let executeId = "";
    let writeExecute: ((message: unknown) => void) | undefined;
    const operations: string[] = [];
    const pipe = await listen((request, write) => {
      operations.push(request.operation);
      if (request.operation === "execute") {
        executeId = request.id;
        writeExecute = write;
        return;
      }
      expect(request).toMatchObject({
        operation: "cancel",
        params: { operationId: executeId },
      });
      write({
        id: request.id,
        result: { cancelled: true, operationId: executeId },
        type: "response",
      });
      writeExecute?.({
        error: {
          code: "CANCELLED",
          message: "Remote command and its process tree were cancelled",
          retryable: false,
        },
        id: executeId,
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));
    const controller = new AbortController();

    const running = executor.execute(["sleep", "30"], {
      sideEffect: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(executeId).not.toBe(""));
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(operations).toEqual(["execute", "cancel"]);
    executor.close();
  });

  it("routes tracked background task lifecycle requests", async () => {
    const operations: TransportRequest[] = [];
    const pipe = await listen((request, write) => {
      operations.push(request);
      const summary = {
        taskId: "bg-task",
        status: request.operation === "backgroundCancel" ? "cancelled" : "running",
        actualCwd: "/workspace",
        startedAtMs: 10,
        completedAtMs: null,
        exitCode: null,
        signal: null,
        cancellationRequested: request.operation === "backgroundCancel",
        logBaseCursor: 0,
        logCursor: 3,
      };
      write({
        id: request.id,
        result:
          request.operation === "backgroundLog"
            ? {
                task: summary,
                events: [
                  {
                    channel: "stdout",
                    contentBase64: "b2sK",
                    cursor: 0,
                  },
                ],
                nextCursor: 3,
                truncated: false,
                hasMore: false,
              }
            : summary,
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(
      executor.startBackgroundTask("bg-task", ["npm", "test"], {
        cwd: "packages/core",
        env: { CI: "1" },
        timeoutMs: 90_000,
      }),
    ).resolves.toMatchObject({ taskId: "bg-task", status: "running" });
    await expect(executor.backgroundTaskStatus("bg-task")).resolves.toMatchObject({
      status: "running",
    });
    await expect(
      executor.readBackgroundTaskLog("bg-task", 2, 1024),
    ).resolves.toMatchObject({ nextCursor: 3 });
    await expect(executor.cancelBackgroundTask("bg-task")).resolves.toMatchObject({
      cancellationRequested: true,
      status: "cancelled",
    });

    expect(operations.map((request) => request.operation)).toEqual([
      "backgroundStart",
      "backgroundStatus",
      "backgroundLog",
      "backgroundCancel",
    ]);
    expect(operations[0]).toMatchObject({
      params: {
        argv: ["npm", "test"],
        cwd: "packages/core",
        env: { CI: "1" },
        taskId: "bg-task",
        timeoutMs: 90_000,
      },
    });
    expect(operations[2]).toMatchObject({
      params: { cursor: 2, limitBytes: 1024, taskId: "bg-task" },
    });
    executor.close();
  });

  it("recovers a background start by task id after transport disconnect", async () => {
    const operations: string[] = [];
    const pipe = await listen((request, write, disconnect) => {
      operations.push(request.operation);
      if (request.operation === "backgroundStart") {
        disconnect();
        return;
      }
      write({
        id: request.id,
        result: {
          taskId: "bg-recover",
          status: "running",
          actualCwd: "/workspace",
          startedAtMs: 10,
          completedAtMs: null,
          exitCode: null,
          signal: null,
          cancellationRequested: false,
          logBaseCursor: 0,
          logCursor: 0,
        },
        type: "response",
      });
    });
    const executor = new VsCodeRemoteExecutor(config(pipe));

    await expect(
      executor.startBackgroundTask("bg-recover", ["sleep", "30"]),
    ).resolves.toMatchObject({
      idempotencyOutcome: "replayed",
      status: "running",
      taskId: "bg-recover",
    });
    expect(operations).toEqual(["backgroundStart", "backgroundStatus"]);
    executor.close();
  });
});
