import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ShimProxy } from "../src/shim/proxy.js";

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
});
