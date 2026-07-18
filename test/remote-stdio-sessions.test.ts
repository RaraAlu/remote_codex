import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteStdioEvent } from "../src/core/vscode-transport.js";
import {
  RemoteStdioSessions,
  type SpawnStdioProcess,
} from "../src/remote-extension/stdio-sessions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("RemoteStdioSessions", () => {
  it("bridges stdin, stdout, stderr, and exit without exposing the extension environment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-stdio-"));
    temporaryDirectories.push(workspace);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    let spawnOptions: Record<string, unknown> | undefined;
    const spawnProcess: SpawnStdioProcess = (_command, _args, options) => {
      spawnOptions = options as Record<string, unknown>;
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    };
    const events: RemoteStdioEvent[] = [];
    const sessions = new RemoteStdioSessions(
      async (event) => {
        events.push(event);
      },
      spawnProcess,
      async () => "/remote/bin/index-mcp",
    );
    const input: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => input.push(chunk));

    await sessions.start({
      args: ["serve", "--mcp"],
      executable: "index-mcp",
      id: "session-1",
      maxFrameBytes: 1024,
      workspaceRoot: workspace,
    });
    await sessions.write("session-1", Buffer.from("request\n").toString("base64"), 1024);
    child.stdout.write("response\n");
    child.stderr.write("notice\n");
    child.emit("close", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Buffer.concat(input).toString()).toBe("request\n");
    expect(spawnOptions?.cwd).toBe(workspace);
    expect((spawnOptions?.env as NodeJS.ProcessEnv).CODEX_HOME).toBeUndefined();
    expect(events).toEqual([
      {
        channel: "stdout",
        chunk: Buffer.from("response\n").toString("base64"),
        event: "data",
        id: "session-1",
      },
      {
        channel: "stderr",
        chunk: Buffer.from("notice\n").toString("base64"),
        event: "data",
        id: "session-1",
      },
      { event: "exit", exitCode: 0, id: "session-1", signal: null },
    ]);
  });
});
