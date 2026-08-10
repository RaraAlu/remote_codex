import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { TransportRequest } from "../src/core/vscode-transport.js";
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

describe("remote fuzzy file search proxy", () => {
  it("serves Codex session search from the active Remote SSH workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-fuzzy-search-"));
    directories.push(directory);
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codex-fuzzy-search-${process.pid}`
        : join(directory, "controller.sock");
    const observed: TransportRequest[] = [];
    const server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.once("line", (line) => {
        const request = JSON.parse(line) as TransportRequest;
        observed.push(request);
        socket.end(
          `${JSON.stringify({
            id: request.id,
            result: {
              files: [
                {
                  file_name: "record_torque.py",
                  indices: [23, 24, 25, 26, 27, 28],
                  match_type: "file",
                  path: "src/locomotion/scripts/record_torque.py",
                  root: "/remote/workspace",
                  score: 2_900,
                },
              ],
              scannedFileCount: 73,
              truncated: false,
            },
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
      clientIdentity: { clientId: "stdio", clientSource: "vscode" },
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
    const forwarded: unknown[] = [];
    const responses: Array<Record<string, unknown>> = [];
    let completeSearch: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      completeSearch = resolve;
    });
    const writeClient = (message: unknown): void => {
      responses.push(message as Record<string, unknown>);
      if (
        (message as { method?: string }).method ===
        "fuzzyFileSearch/sessionCompleted"
      ) {
        completeSearch?.();
      }
    };

    try {
      await proxy.handleClientMessage(
        {
          id: "start-1",
          method: "fuzzyFileSearch/sessionStart",
          params: { roots: ["/remote/workspace"], sessionId: "search-1" },
        },
        (message) => forwarded.push(message),
        writeClient,
      );
      await proxy.handleClientMessage(
        {
          id: "update-1",
          method: "fuzzyFileSearch/sessionUpdate",
          params: { query: "torque", sessionId: "search-1" },
        },
        (message) => forwarded.push(message),
        writeClient,
      );
      await completed;
      await proxy.handleClientMessage(
        {
          id: "stop-1",
          method: "fuzzyFileSearch/sessionStop",
          params: { sessionId: "search-1" },
        },
        (message) => forwarded.push(message),
        writeClient,
      );
    } finally {
      proxy.closeSession();
    }

    expect(forwarded).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      operation: "resolveFuzzyFileSearch",
      params: {
        maxResults: 100,
        query: "torque",
        rootId: "remote-primary",
      },
      workspaceRoot: "/remote/workspace",
    });
    expect(responses).toEqual([
      { id: "start-1", result: {} },
      { id: "update-1", result: {} },
      expect.objectContaining({
        method: "fuzzyFileSearch/sessionUpdated",
        params: { files: [], query: "torque", sessionId: "search-1" },
      }),
      expect.objectContaining({
        method: "fuzzyFileSearch/sessionUpdated",
        params: {
          files: [
            expect.objectContaining({
              path: "src/locomotion/scripts/record_torque.py",
              root: "/remote/workspace",
            }),
          ],
          query: "torque",
          sessionId: "search-1",
        },
      }),
      expect.objectContaining({
        method: "fuzzyFileSearch/sessionCompleted",
        params: { sessionId: "search-1" },
      }),
      { id: "stop-1", result: {} },
    ]);
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"operation":"fuzzy_file_search.session_start"');
    expect(audit).toContain('"operation":"fuzzy_file_search.session_update"');
    expect(audit).toContain('"operation":"fuzzy_file_search.session_stop"');
    expect(audit).toContain('"scannedFileCount":73');
    expect(audit).not.toContain("torque");
  });
});
