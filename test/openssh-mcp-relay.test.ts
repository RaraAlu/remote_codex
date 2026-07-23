import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { OpenSshMcpRelay } from "../src/shim/openssh-mcp-relay.js";

describe("OpenSshMcpRelay", () => {
  it("sends reviewed adapter values over stdin instead of the SSH command line", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const stdinChunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk));
    let observedArgs: readonly string[] = [];
    const input = new PassThrough();
    const relay = new OpenSshMcpRelay({
      adapterId: "codegraph-all-tools-v1",
      args: ["serve", "--mcp", "--path", "/workspace"],
      config: parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/workspace",
      }),
      executable: "codegraph",
      input,
      serverName: "codegraph",
      spawnProcess: (_command, args) => {
        observedArgs = args;
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      },
    });

    const running = relay.run();
    input.end("request\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emit("close", 0, null);

    await expect(running).resolves.toBe(0);
    const commandLine = observedArgs.join(" ");
    expect(commandLine).toContain("missing MCP adapter header");
    expect(commandLine).not.toContain("search,callers,callees");
    expect(Buffer.concat(stdinChunks).toString()).toBe(
      "1\n" +
        "CODEGRAPH_MCP_TOOLS=search,callers,callees,impact,node,explore,status,files\n" +
        "request\n",
    );
  });
});
