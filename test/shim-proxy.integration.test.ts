import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { SpawnProcess } from "../src/core/ssh-executor.js";
import { ShimProxy } from "../src/shim/proxy.js";
import { isRecord } from "../src/shim/rpc.js";

function fakeAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        process.stdout.write(JSON.stringify({ id: message.id, result: { received: message } }) + "\\n");
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

function fakeRemoteExecAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    const call = {
      callId: "remote-item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "remote_exec",
      arguments: { argv: ["printf", "hello"], cwd: "src" },
    };
    const emitCall = () => {
      process.stdout.write(JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: call.callId,
            type: "dynamicToolCall",
            tool: call.tool,
            arguments: call.arguments,
            status: "inProgress",
            success: null,
          },
        },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        id: "remote-tool-request-1",
        method: "item/tool/call",
        params: call,
      }) + "\\n");
    };
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "bridge/testRemoteExec") {
        emitCall();
        return;
      }
      if (message.method === "thread/start") {
        process.stdout.write(JSON.stringify({
          id: message.id,
          result: { thread: { id: call.threadId } },
        }) + "\\n");
        emitCall();
        return;
      }
      if (message.id === "remote-tool-request-1") {
        const result = message.result;
        process.stdout.write(JSON.stringify({
          method: "item/completed",
          params: {
            item: {
              id: call.callId,
              type: "dynamicToolCall",
              tool: call.tool,
              arguments: call.arguments,
              status: result?.success ? "completed" : "failed",
              success: result?.success === true,
              contentItems: result?.contentItems ?? [],
            },
          },
        }) + "\\n");
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

async function exerciseRemoteExecApproval(
  decision: "accept" | "decline" | null,
  fullAccess = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-approval-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  let sshSpawns = 0;
  let finishCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    finishCompleted = resolve;
  });
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        continue;
      }
      messages.push(parsed);
      if (
        parsed.method === "item/commandExecution/requestApproval" &&
        (typeof parsed.id === "string" || typeof parsed.id === "number")
      ) {
        input.write(
          `${JSON.stringify({
            id: parsed.id,
            result: { decision: decision ?? "decline" },
          })}\n`,
        );
      }
      if (parsed.method === "item/completed") {
        finishCompleted?.();
      }
    }
  });

  const spawnSsh: SpawnProcess = () => {
    sshSpawns += 1;
    return spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('/remote/workspace/src\\0hello\\n'); process.stderr.write('notice\\n');",
      ],
      { stdio: "pipe" },
    );
  };
  const proxy = new ShimProxy({
    appServerArgs: ["app-server", "--stdio"],
    auditPath: join(directory, "audit.jsonl"),
    codexExecutable: "fake-codex",
    config: parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
    }),
    controlDir: join(directory, "control"),
    input,
    output,
    errorOutput: new PassThrough(),
    spawnCodex: () => fakeRemoteExecAppServer(),
    spawnSsh,
  });
  const running = proxy.run();
  input.write(
    `${JSON.stringify(
      fullAccess
        ? {
            id: 1,
            method: "thread/start",
            params: { permissions: "full-access" },
          }
        : { id: 1, method: "bridge/testRemoteExec" },
    )}\n`,
  );
  await completed;
  input.end();
  await expect(running).resolves.toBe(0);
  return { messages, sshSpawns };
}

describe("ShimProxy JSONL integration", () => {
  it("rewrites initialize and thread placement before forwarding to app-server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-proxy-"));
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      captured += chunk;
    });

    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: null,
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput: new PassThrough(),
      spawnCodex: () => fakeAppServer(),
    });
    const running = proxy.run();
    input.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test", title: "Test", version: "1" } },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: "/local/project", sandbox: "danger-full-access" },
      })}\n`,
    );
    input.end();
    await expect(running).resolves.toBe(0);

    const messages = captured
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { result: { received: Record<string, unknown> } });
    const initialize = messages[0]?.result.received as {
      params: { capabilities: { experimentalApi: boolean } };
    };
    const threadStart = messages[1]?.result.received as {
      params: {
        cwd: string;
        runtimeWorkspaceRoots: string[];
        sandbox: string;
      };
    };
    expect(initialize.params.capabilities.experimentalApi).toBe(true);
    expect(threadStart.params).toMatchObject({
      cwd: join(directory, "control"),
      runtimeWorkspaceRoots: [join(directory, "control")],
      sandbox: "read-only",
    });
  });

  it("requires native approval, streams output, and projects remote execution", async () => {
    const { messages, sshSpawns } = await exerciseRemoteExecApproval("accept");
    expect(sshSpawns).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        params: expect.objectContaining({
          itemId: "remote-item-1",
          command: "printf hello",
          cwd: "/remote/workspace/src",
          availableDecisions: ["accept", "decline"],
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/commandExecution/outputDelta",
        params: expect.objectContaining({
          itemId: "remote-item-1",
          delta: "hello\n",
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: "commandExecution",
            command: "printf hello",
            status: "completed",
          }),
        }),
      }),
    );
  });

  it("returns a declined tool result without starting OpenSSH", async () => {
    const { messages, sshSpawns } = await exerciseRemoteExecApproval("decline");
    expect(sshSpawns).toBe(0);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: "commandExecution",
            status: "failed",
            aggregatedOutput: "Remote command execution was declined by the user",
          }),
        }),
      }),
    );
  });

  it("inherits full access and runs remotely without an extra approval prompt", async () => {
    const { messages, sshSpawns } = await exerciseRemoteExecApproval(null, true);
    expect(sshSpawns).toBe(1);
    expect(
      messages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/commandExecution/outputDelta",
        params: expect.objectContaining({
          itemId: "remote-item-1",
          delta: "hello\n",
        }),
      }),
    );
  });
});
