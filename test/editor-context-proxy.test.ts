import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type {
  RemoteEditorContext,
  TransportRequest,
} from "../src/core/vscode-transport.js";
import { ShimProxy } from "../src/shim/proxy.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("remote editor context proxy", () => {
  it("resolves and injects fresh automatic VS Code context on every turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-editor-context-"));
    directories.push(directory);
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codex-editor-context-${process.pid}`
        : join(directory, "controller.sock");
    const content = "REMOTE_SELECTION_LINE_L03_0331";
    const queued: RemoteEditorContext = {
      capturedAtMs: 1,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      contextId: "context-1",
      hostId: "remote-host",
      kind: "selection",
      languageId: "plaintext",
      origin: "automatic",
      relativePath: "context.txt",
      resourceUri:
        "codex-bridge://workspace/remote-primary/context.txt?host=remote-host&target=remote",
      rootId: "remote-primary",
      selection: {
        start: { column: 1, line: 2 },
        end: { column: 31, line: 2 },
      },
      sizeBytes: Buffer.byteLength(content),
      target: "remote",
      workspaceRoot: "/remote/workspace",
      workspaceUri:
        "vscode-remote://ssh-remote%2Bremote-host/remote/workspace/context.txt",
    };
    const observed: TransportRequest[] = [];
    let editorContexts = 0;
    const server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.once("line", (line) => {
        const request = JSON.parse(line) as TransportRequest;
        observed.push(request);
        const result =
          request.operation === "resolveConversationResources"
            ? []
            : {
                ...queued,
                contextId: `context-${++editorContexts}`,
              };
        socket.end(
          `${JSON.stringify({
            id: request.id,
            result,
            type: "response",
          })}\n`,
        );
      });
    });
    servers.push(server);
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
        connectionMode: "vscode-remote",
        host: "remote-host",
        remoteHelper: "vscode-extension",
        vscodeTransport: {
          endpoint,
          sessionId: "test-session",
          token: "0123456789abcdef0123456789abcdef",
        },
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
    });
    const forwarded: Array<Record<string, unknown>> = [];
    const rejected: unknown[] = [];

    try {
      await proxy.handleClientMessage(
        {
          id: "turn-1",
          method: "turn/start",
          params: { threadId: "thread-1", input: [] },
        },
        (message) => forwarded.push(message as Record<string, unknown>),
        (message) => rejected.push(message),
      );
      await proxy.handleClientMessage(
        {
          id: "turn-2",
          method: "turn/start",
          params: { threadId: "thread-1", input: [] },
        },
        (message) => forwarded.push(message as Record<string, unknown>),
        (message) => rejected.push(message),
      );
    } finally {
      proxy.closeSession();
    }

    expect(rejected).toEqual([]);
    expect(observed).toHaveLength(4);
    expect(observed[0]).toMatchObject({
      operation: "resolveConversationResources",
      params: { mentionPaths: [], threadId: "thread-1" },
    });
    expect(observed[1]).toMatchObject({
      operation: "resolveEditorContext",
      params: { rootId: "remote-primary" },
    });
    expect(observed[2]).toMatchObject({
      operation: "resolveConversationResources",
      params: { mentionPaths: [], threadId: "thread-1" },
    });
    expect(observed[3]).toMatchObject({ operation: "resolveEditorContext" });
    const firstContext = (
      forwarded[0]?.params as {
        additionalContext: Record<string, { value: string }>;
      }
    ).additionalContext;
    expect(firstContext["codex-remote-bridge-editor-context"]?.value).toContain(
      JSON.stringify(content),
    );
    expect(firstContext["codex-remote-bridge-editor-context"]?.value).toContain(
      "captured automatically",
    );
    const secondContext = (
      forwarded[1]?.params as {
        additionalContext: Record<string, { value: string }>;
      }
    ).additionalContext;
    expect(secondContext["codex-remote-bridge-editor-context"]?.value).toContain(
      JSON.stringify(content),
    );
    const audit = await readFile(auditPath, "utf8");
    expect(audit.match(/"operation":"editor_context.inject"/g)).toHaveLength(2);
    expect(audit).toContain('"contextId":"context-1"');
    expect(audit).toContain('"contextId":"context-2"');
    expect(audit).toContain('"origin":"automatic"');
    expect(audit).not.toContain(content);
  });
});
