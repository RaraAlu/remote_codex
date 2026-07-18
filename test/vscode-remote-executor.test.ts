import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { VsCodeRemoteExecutor } from "../src/core/vscode-remote-executor.js";
import type { TransportRequest } from "../src/core/vscode-transport.js";

let server: Server | null = null;
let endpoint: string | null = null;

async function listen(
  respond: (request: TransportRequest, write: (message: unknown) => void) => void,
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
      respond(request, (message) => socket.write(`${JSON.stringify(message)}\n`));
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
        onStdout: (chunk) => streamed.push(chunk),
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "done" });
    expect(streamed).toEqual(["streamed"]);
    expect(observed).toMatchObject({
      hostId: "remote-host",
      operation: "execute",
      token: "0123456789abcdef0123456789abcdef",
      workspaceRoot: "/workspace",
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
});
