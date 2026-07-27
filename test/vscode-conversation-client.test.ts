import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  closeVsCodeConversationClients,
  interveneVsCodeConversation,
  startVsCodeConversation,
} from "../src/shim/vscode-conversation-client.js";

let stateDirectory: string | null = null;
let server: WebSocketServer | null = null;
const originalStateDirectory = process.env.CODEX_BRIDGE_STATE_DIR;

afterEach(async () => {
  closeVsCodeConversationClients();
  for (const socket of server?.clients ?? []) {
    socket.terminate();
  }
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  if (stateDirectory) {
    await rm(stateDirectory, { force: true, recursive: true });
  }
  if (originalStateDirectory === undefined) {
    delete process.env.CODEX_BRIDGE_STATE_DIR;
  } else {
    process.env.CODEX_BRIDGE_STATE_DIR = originalStateDirectory;
  }
  stateDirectory = null;
  server = null;
});

describe("VS Code conversation client", () => {
  it("starts a fresh thread before the first turn so current tools can be injected", async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "codex-bridge-conversation-"));
    process.env.CODEX_BRIDGE_STATE_DIR = stateDirectory;
    const externalCliDirectory = join(stateDirectory, "external-cli");
    await mkdir(externalCliDirectory, { recursive: true });

    const threadId = randomUUID();
    const requestMethods: string[] = [];
    const requestParams = new Map<string, unknown>();
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          id?: number;
          method?: string;
          params?: unknown;
        };
        if (message.id === undefined || !message.method) {
          return;
        }
        requestMethods.push(message.method);
        requestParams.set(message.method, message.params);
        const result =
          message.method === "thread/start"
            ? { thread: { id: threadId, status: { type: "idle" } } }
            : message.method === "turn/start"
              ? { turn: { id: "turn-fresh", status: "inProgress" } }
              : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", resolve);
      server?.once("error", reject);
    });

    const address = server.address() as AddressInfo;
    const tokenPath = join(externalCliDirectory, `${process.pid}.token`);
    await writeFile(tokenPath, "test-token", { mode: 0o600 });
    await writeFile(
      join(externalCliDirectory, `${process.pid}.json`),
      JSON.stringify({
        version: 1,
        endpoint: `ws://127.0.0.1:${address.port}`,
        host: "remote-host",
        pid: process.pid,
        startedAtMs: Date.now(),
        tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
        tokenPath,
        workspaceRoot: "/remote/workspace",
      }),
    );

    await expect(
      startVsCodeConversation({
        permissionMode: "full-access",
        sessionPid: process.pid,
        text: "inspect the remote project",
      }),
    ).resolves.toMatchObject({
      sessionPid: process.pid,
      threadId,
      thread: { id: threadId },
      turn: { turn: { id: "turn-fresh" } },
    });
    expect(requestMethods).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(requestParams.get("thread/start")).toEqual({
      approvalPolicy: "never",
      permissions: "full-access",
    });
    expect(requestParams.get("turn/start")).toMatchObject({
      threadId,
      input: [{ type: "text", text: "inspect the remote project" }],
      responsesapiClientMetadata: {
        codex_bridge_origin: "external-cli-mcp",
      },
    });
  });

  it("resumes a historical thread before starting a new turn", async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "codex-bridge-conversation-"));
    process.env.CODEX_BRIDGE_STATE_DIR = stateDirectory;
    const externalCliDirectory = join(stateDirectory, "external-cli");
    await mkdir(externalCliDirectory, { recursive: true });

    const threadId = randomUUID();
    const requestMethods: string[] = [];
    const requestParams = new Map<string, unknown>();
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          id?: number;
          method?: string;
          params?: unknown;
        };
        if (message.id === undefined || !message.method) {
          return;
        }
        requestMethods.push(message.method);
        requestParams.set(message.method, message.params);
        const result =
          message.method === "thread/read"
            ? { thread: { id: threadId, status: { type: "notLoaded" } } }
            : message.method === "thread/resume"
              ? { thread: { id: threadId, status: { type: "idle" }, turns: [] } }
              : message.method === "turn/start"
                ? { turn: { id: "turn-1", status: "inProgress" } }
                : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", resolve);
      server?.once("error", reject);
    });

    const address = server.address() as AddressInfo;
    const tokenPath = join(externalCliDirectory, `${process.pid}.token`);
    await writeFile(tokenPath, "test-token", { mode: 0o600 });
    await writeFile(
      join(externalCliDirectory, `${process.pid}.json`),
      JSON.stringify({
        version: 1,
        endpoint: `ws://127.0.0.1:${address.port}`,
        host: "remote-host",
        pid: process.pid,
        startedAtMs: Date.now(),
        tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
        tokenPath,
        workspaceRoot: "/remote/workspace",
      }),
    );

    await expect(
      interveneVsCodeConversation({
        mode: "new-turn",
        sessionPid: process.pid,
        text: "continue",
        threadId,
      }),
    ).resolves.toMatchObject({
      action: "new-turn",
      result: { turn: { id: "turn-1" } },
      threadId,
    });
    expect(requestMethods).toEqual([
      "initialize",
      "thread/read",
      "thread/resume",
      "turn/start",
    ]);
    expect(requestParams.get("thread/resume")).toEqual({
      threadId,
      excludeTurns: true,
    });
  });
});

const liveSessionPid = Number(process.env.CODEX_BRIDGE_LIVE_CONVERSATION_SESSION_PID);
const liveThreadId = process.env.CODEX_BRIDGE_LIVE_CONVERSATION_THREAD_ID;

describe.skipIf(!Number.isSafeInteger(liveSessionPid) || !liveThreadId)(
  "VS Code conversation client live acceptance",
  () => {
    it("resumes and continues a real historical VS Code thread", async () => {
      await expect(
        interveneVsCodeConversation({
          mode: "new-turn",
          sessionPid: liveSessionPid,
          text: "Bridge 0.3.11 历史会话接管验收：不要调用任何工具，只回复 HISTORICAL_THREAD_INTERVENE_0311_OK。",
          threadId: liveThreadId!,
        }),
      ).resolves.toMatchObject({
        action: "new-turn",
        sessionPid: liveSessionPid,
        threadId: liveThreadId,
      });
    });
  },
);
