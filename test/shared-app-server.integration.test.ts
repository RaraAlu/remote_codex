import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import {
  bridgeExternalCliSessionPath,
  bridgeExternalCliTokenPath,
} from "../src/core/locations.js";
import {
  SharedAppServer,
  withSharedWebSocketTransport,
  type ExternalCliSessionDescriptor,
} from "../src/shim/shared-app-server.js";
import {
  interveneVsCodeConversation,
  interruptVsCodeConversation,
  listVsCodeConversations,
  readVsCodeConversation,
} from "../src/shim/vscode-conversation-client.js";

const originalStateDirectory = process.env.CODEX_BRIDGE_STATE_DIR;

afterEach(() => {
  if (originalStateDirectory === undefined) {
    delete process.env.CODEX_BRIDGE_STATE_DIR;
  } else {
    process.env.CODEX_BRIDGE_STATE_DIR = originalStateDirectory;
  }
});

function fakeWebSocketAppServer(
  command: string,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  const source = `
    const { readFileSync } = require("node:fs");
    const { WebSocketServer } = require("ws");
    const args = JSON.parse(process.env.FAKE_CODEX_ARGS);
    const listenIndex = args.indexOf("--listen");
    const tokenIndex = args.indexOf("--ws-token-file");
    const endpoint = new URL(args[listenIndex + 1]);
    const token = readFileSync(args[tokenIndex + 1], "utf8");
    const server = new WebSocketServer({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      verifyClient: ({ req }, done) => {
        done(req.headers.authorization === "Bearer " + token, 401, "Unauthorized");
      },
    });
    let activeTurnId = null;
    let turnNumber = 0;
    const broadcastNotifications = process.env.FAKE_BROADCAST_NOTIFICATIONS === "1";
    const notify = (origin, message) => {
      const raw = JSON.stringify(message);
      if (!broadcastNotifications) {
        origin.send(raw);
        return;
      }
      for (const client of server.clients) {
        if (client.readyState === 1) client.send(raw);
      }
    };
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
          return;
        }
        if (message.method === "thread/start" || message.method === "thread/resume") {
          const thread = { id: "thread-shared" };
          socket.send(JSON.stringify({
            id: message.id,
            result: { thread, observedParams: message.params },
          }));
          notify(socket, { method: "thread/started", params: { thread } });
          return;
        }
        if (message.method === "thread/list") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              data: [{ id: "thread-shared", name: "VS Code active task" }],
              nextCursor: null,
            },
          }));
          return;
        }
        if (message.method === "thread/read") {
          socket.send(JSON.stringify({
            id: message.id,
            result: { thread: { id: "thread-shared" } },
          }));
          return;
        }
        if (message.method === "thread/turns/list") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              data: activeTurnId
                ? [{ id: activeTurnId, status: "inProgress", items: [] }]
                : [],
              nextCursor: null,
            },
          }));
          return;
        }
        if (message.method === "turn/start") {
          turnNumber += 1;
          activeTurnId = turnNumber === 1 ? "turn-shared" : "turn-shared-" + turnNumber;
          const turn = { id: activeTurnId, status: "inProgress" };
          socket.send(JSON.stringify({ id: message.id, result: { turn } }));
          notify(socket, {
            method: "turn/started",
            params: { threadId: "thread-shared", turn },
          });
          notify(socket, {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-shared",
              turnId: activeTurnId,
              itemId: "agent-message",
              delta: "streamed",
            },
          });
          socket.send(JSON.stringify({
            id: "remote-tool-request",
            method: "item/tool/call",
            params: {
              callId: "remote-item",
              threadId: "thread-shared",
              turnId: activeTurnId,
              tool: "remote_exec",
              arguments: { argv: ["printf", "hello"] },
            },
          }));
          return;
        }
        if (message.method === "turn/steer") {
          socket.send(JSON.stringify({
            id: message.id,
            result: { turnId: "turn-shared" },
          }));
          notify(socket, {
            method: "bridge/fakeSteered",
            params: { threadId: "thread-shared", turnId: "turn-shared" },
          });
          return;
        }
        if (message.method === "turn/interrupt") {
          activeTurnId = null;
          socket.send(JSON.stringify({ id: message.id, result: {} }));
          notify(socket, {
            method: "turn/completed",
            params: {
              threadId: "thread-shared",
              turn: { id: message.params.turnId, status: "interrupted" },
            },
          });
          return;
        }
        if (message.id === "remote-tool-request") {
          notify(socket, {
            method: "bridge/fakeRemoteToolResult",
            params: { result: message.result },
          });
        }
      });
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  return spawn(process.execPath, ["-e", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_CODEX_ARGS: JSON.stringify(args),
      FAKE_BROADCAST_NOTIFICATIONS: command.includes("broadcast") ? "1" : "0",
    },
    stdio: "pipe",
  });
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for shared app-server test state");
}

async function readDescriptor(path: string): Promise<ExternalCliSessionDescriptor | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ExternalCliSessionDescriptor;
  } catch {
    return undefined;
  }
}

function collectJsonLines(stream: PassThrough): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return messages;
}

describe("SharedAppServer", () => {
  it("replaces stdio transport and stale websocket credentials", () => {
    expect(
      withSharedWebSocketTransport(
        [
          "-c",
          "feature=true",
          "app-server",
          "--listen",
          "stdio://",
          "--ws-auth",
          "signed-bearer-token",
          "--ws-shared-secret-file",
          "/tmp/old",
        ],
        "ws://127.0.0.1:3456",
        "/tmp/new-token",
      ),
    ).toEqual([
      "-c",
      "feature=true",
      "app-server",
      "--listen",
      "ws://127.0.0.1:3456",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/tmp/new-token",
    ]);
  });

  it("lets an authenticated external client resume, steer, and interrupt the VS Code thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-app-server-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    let sshSpawns = 0;
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex-connection-local",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
      spawnSsh: () => {
        sshSpawns += 1;
        return spawn(
          process.execPath,
          ["-e", "process.stdout.write('/remote/workspace\\\\0hello\\\\n')"],
          { stdio: "pipe" },
        );
      },
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: "/local/decoy", permissions: "full-access" },
      })}\n`,
    );
    await waitFor(() =>
      vscodeMessages.some((message) => message.id === 2) ? true : undefined,
    );

    const descriptorPath = bridgeExternalCliSessionPath();
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(descriptorPath);
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    const token = await readFile(bridgeExternalCliTokenPath(), "utf8");
    const unauthorizedStatus = await new Promise<number>((resolvePromise, reject) => {
      const unauthorized = new WebSocket(descriptor.endpoint);
      unauthorized.once("unexpected-response", (_request, response) => {
        resolvePromise(response.statusCode ?? 0);
      });
      unauthorized.once("open", () => reject(new Error("Unauthenticated client connected")));
      unauthorized.once("error", () => undefined);
    });
    expect(unauthorizedStatus).toBe(401);

    await expect(listVsCodeConversations(5)).resolves.toMatchObject({
      sessions: [
        {
          sessionPid: process.pid,
          activeThreadId: "thread-shared",
          threads: {
            data: [{ id: "thread-shared", name: "VS Code active task" }],
          },
        },
      ],
    });
    await expect(readVsCodeConversation("thread-shared", 5)).resolves.toMatchObject({
      threadId: "thread-shared",
      turns: { data: [] },
    });
    await expect(
      interveneVsCodeConversation({
        threadId: "thread-shared",
        text: "start self-test",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-shared",
      action: "new-turn",
      result: { turn: { id: "turn-shared" } },
    });
    await waitFor(() =>
      vscodeMessages.some(
        (message) => message.method === "bridge/fakeRemoteToolResult",
      )
        ? true
        : undefined,
    );
    expect(sshSpawns).toBe(1);
    expect(
      vscodeMessages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    await expect(
      interveneVsCodeConversation({
        threadId: "thread-shared",
        text: "add verification",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-shared",
      action: "steer",
      result: { turnId: "turn-shared" },
    });
    await expect(
      interruptVsCodeConversation({
        threadId: "thread-shared",
        turnId: "turn-shared",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-shared",
      turnId: "turn-shared",
    });

    const external = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const externalMessages: Array<Record<string, unknown>> = [];
    external.on("message", (data) => {
      externalMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolvePromise, reject) => {
      external.once("open", resolvePromise);
      external.once("error", reject);
    });
    external.send(
      JSON.stringify({ id: 10, method: "initialize", params: { clientInfo: {} } }),
    );
    external.send(
      JSON.stringify({
        id: 11,
        method: "thread/resume",
        params: {
          threadId: descriptor.threadId,
          cwd: "/local/decoy",
          permissions: "read-only",
        },
      }),
    );
    external.send(
      JSON.stringify({
        id: 12,
        method: "turn/start",
        params: { threadId: descriptor.threadId, input: [] },
      }),
    );
    external.send(
      JSON.stringify({
        id: 13,
        method: "turn/steer",
        params: {
          threadId: descriptor.threadId,
          expectedTurnId: "turn-shared",
          input: [{ type: "text", text: "intervene" }],
        },
      }),
    );
    external.send(
      JSON.stringify({
        id: 14,
        method: "turn/interrupt",
        params: { threadId: descriptor.threadId, turnId: "turn-shared" },
      }),
    );

    await waitFor(() =>
      externalMessages.some((message) => message.id === 14) ? true : undefined,
    );
    expect(vscodeMessages).toContainEqual({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-shared",
        turnId: "turn-shared",
        itemId: "agent-message",
        delta: "streamed",
      },
    });
    expect(externalMessages).toContainEqual(expect.objectContaining({
      id: 11,
      result: expect.objectContaining({ thread: { id: "thread-shared" } }),
    }));
    expect(externalMessages).toContainEqual({
      id: 13,
      result: { turnId: "turn-shared" },
    });
    expect(sshSpawns).toBe(2);
    expect(vscodeMessages).toContainEqual({
      method: "bridge/fakeSteered",
      params: { threadId: "thread-shared", turnId: "turn-shared" },
    });
    expect(vscodeMessages).toContainEqual({
      method: "turn/completed",
      params: {
        threadId: "thread-shared",
        turn: { id: "turn-shared", status: "interrupted" },
      },
    });

    const externalTurnStarts = externalMessages.filter(
      (message) => message.method === "turn/started",
    ).length;
    input.write(
      `${JSON.stringify({
        id: 15,
        method: "turn/start",
        params: {
          threadId: descriptor.threadId,
          input: [{ type: "text", text: "from vscode" }],
        },
      })}\n`,
    );
    const mirroredVsCodeTurn = await waitFor(() =>
      externalMessages.filter((message) => message.method === "turn/started")[
        externalTurnStarts
      ],
    );
    const mirroredVsCodeTurnId = (
      (mirroredVsCodeTurn.params as Record<string, unknown>).turn as Record<
        string,
        unknown
      >
    ).id;
    expect(externalMessages).toContainEqual({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-shared",
        turnId: mirroredVsCodeTurnId,
        itemId: "agent-message",
        delta: "streamed",
      },
    });
    const externalCompletions = externalMessages.filter(
      (message) => message.method === "turn/completed",
    ).length;
    input.write(
      `${JSON.stringify({
        id: 16,
        method: "turn/interrupt",
        params: {
          threadId: descriptor.threadId,
          turnId: mirroredVsCodeTurnId,
        },
      })}\n`,
    );
    await waitFor(() =>
      externalMessages.filter((message) => message.method === "turn/completed").length >
      externalCompletions
        ? true
        : undefined,
    );

    external.close();
    input.write(
      `${JSON.stringify({
        id: 17,
        method: "thread/list",
        params: { limit: 1, sourceKinds: ["vscode"] },
      })}\n`,
    );
    await waitFor(() =>
      vscodeMessages.some((message) => message.id === 17) ? true : undefined,
    );
    input.end();
    await expect(running).resolves.toBe(0);
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const auditEntries = (await readFile(join(directory, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      auditEntries.some((entry) => {
        const details = entry.details as Record<string, unknown> | undefined;
        return (
          entry.operation === "external_cli.disconnect" &&
          typeof details?.notificationsRelayedToVsCode === "number" &&
          details.notificationsRelayedToVsCode > 0
        );
      }),
    ).toBe(true);
  });

  it("publishes a local VS Code thread without applying Remote SSH rewrites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-local-app-server-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      appServerCwd: directory,
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: null,
      controlDir: directory,
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
      spawnSsh: () => {
        throw new Error("Local shared app-server must not start SSH");
      },
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: {
          cwd: workspaceRoot,
          permissions: "workspace-write",
          approvalPolicy: "on-request",
        },
      })}\n`,
    );
    const response = await waitFor(() =>
      vscodeMessages.find((message) => message.id === 2),
    );
    expect(response).toMatchObject({
      result: {
        observedParams: {
          cwd: workspaceRoot,
          permissions: "workspace-write",
          approvalPolicy: "on-request",
        },
      },
    });
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    expect(descriptor).toMatchObject({
      host: "local",
      workspaceRoot,
      threadId: "thread-shared",
    });

    input.end();
    await expect(running).resolves.toBe(0);
  });

  it("deduplicates notifications broadcast by multiple upstream connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-broadcast-app-server-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      appServerCwd: directory,
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex-broadcast",
      config: null,
      controlDir: directory,
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: directory, permissions: "full-access" },
      })}\n`,
    );
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    const initialVsCodeNotifications = vscodeMessages.filter(
      (message) => message.method === "thread/started",
    ).length;
    const token = await readFile(bridgeExternalCliTokenPath(), "utf8");
    const external = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const externalMessages: Array<Record<string, unknown>> = [];
    external.on("message", (data) => {
      externalMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolvePromise, reject) => {
      external.once("open", resolvePromise);
      external.once("error", reject);
    });
    external.send(
      JSON.stringify({ id: 10, method: "initialize", params: { clientInfo: {} } }),
    );
    external.send(
      JSON.stringify({
        id: 11,
        method: "thread/resume",
        params: { threadId: descriptor.threadId, cwd: directory },
      }),
    );
    await waitFor(() =>
      externalMessages.some((message) => message.id === 11) ? true : undefined,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    expect(
      vscodeMessages.filter((message) => message.method === "thread/started"),
    ).toHaveLength(initialVsCodeNotifications + 1);
    expect(
      externalMessages.filter((message) => message.method === "thread/started"),
    ).toHaveLength(1);

    external.close();
    input.end();
    await expect(running).resolves.toBe(0);
  });
});
