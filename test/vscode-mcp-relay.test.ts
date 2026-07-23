import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { VsCodeMcpRelay } from "../src/shim/vscode-mcp-relay.js";

let server: Server | null = null;
let endpoint: string | null = null;

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

describe("VsCodeMcpRelay", () => {
  it("relays a generic MCP byte stream over the window transport", async () => {
    const id = randomUUID();
    endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codex-mcp-relay-test-${id}`
        : join(tmpdir(), `codex-mcp-relay-test-${id}.sock`);
    if (process.platform !== "win32") {
      await mkdir(tmpdir(), { recursive: true });
      await rm(endpoint, { force: true });
    }
    let observedStart: Record<string, unknown> | null = null;
    let observedInput = "";
    server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.operation === "stdioStart") {
          observedStart = message;
          socket.write(`${JSON.stringify({ id: message.id, type: "stdioReady" })}\n`);
          return;
        }
        if (message.type === "stdioInput") {
          observedInput += Buffer.from(String(message.chunk), "base64").toString();
          return;
        }
        if (message.type === "stdioEnd") {
          socket.write(
            `${JSON.stringify({
              channel: "stdout",
              chunk: Buffer.from("response\n").toString("base64"),
              id: message.id,
              type: "stdioOutput",
            })}\n`,
          );
          socket.write(
            `${JSON.stringify({
              exitCode: 0,
              id: message.id,
              signal: null,
              type: "stdioExit",
            })}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(endpoint as string, resolve);
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const outputChunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    const config = parseBridgeConfig({
      host: "remote-host",
      workspaceRoot: "/workspace",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
      vscodeTransport: {
        endpoint,
        sessionId: "test-session",
        token: "0123456789abcdef0123456789abcdef",
      },
    });
    const relay = new VsCodeMcpRelay({
      adapterId: "codegraph-all-tools-v1",
      args: ["serve", "--mcp", "--path", "/workspace"],
      config,
      errorOutput,
      executable: "codegraph",
      input,
      output,
      serverName: "codegraph",
    });
    const running = relay.run();
    input.end("request\n");

    await expect(running).resolves.toBe(0);
    expect(observedStart).toMatchObject({
      operation: "stdioStart",
      params: {
        adapterId: "codegraph-all-tools-v1",
        args: ["serve", "--mcp", "--path", "/workspace"],
        executable: "codegraph",
        serverName: "codegraph",
      },
    });
    expect(observedInput).toBe("request\n");
    expect(Buffer.concat(outputChunks).toString()).toBe("response\n");
  });
});
