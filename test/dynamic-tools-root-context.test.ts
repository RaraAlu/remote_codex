import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/core/audit-log.js";
import { parseBridgeConfig } from "../src/core/config.js";
import type { OpenSshExecutor } from "../src/core/ssh-executor.js";
import type { ConversationResourceConfig } from "../src/core/types.js";
import {
  DynamicToolRouter,
  REMOTE_DYNAMIC_TOOLS,
} from "../src/shim/dynamic-tools.js";

function parseResult(response: unknown): Record<string, unknown> {
  const value = response as {
    contentItems?: Array<{ text?: string }>;
  };
  return JSON.parse(value.contentItems?.[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("dynamic tool root context", () => {
  it("exposes remote root selectors and returns an explicit root identity", async () => {
    const readTool = REMOTE_DYNAMIC_TOOLS.find(
      (tool) => tool.name === "workspace_read_file",
    );
    expect(readTool?.inputSchema.properties).toMatchObject({
      target: { enum: ["local", "remote"] },
      rootId: { type: "string" },
    });
    const writeTool = REMOTE_DYNAMIC_TOOLS.find(
      (tool) => tool.name === "workspace_write_file",
    );
    expect(writeTool?.inputSchema).toMatchObject({
      required: ["path", "contentBase64"],
      properties: {
        expectedHash: { pattern: "^[0-9a-f]{64}$" },
      },
    });

    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-root-context-"));
    try {
      const auditPath = join(directory, "audit.jsonl");
      const config = parseBridgeConfig({
        version: 2,
        host: "remote-host",
        roots: [
          {
            id: "remote-project",
            target: "remote",
            role: "primary",
            path: "/remote/workspace",
            displayName: "Remote project",
          },
        ],
      });
      const localResource: ConversationResourceConfig = {
        id: "context-reference",
        target: "local",
        role: "conversation",
        kind: "directory",
        path: "/local/reference",
        displayName: "Local reference",
        threadId: "thread-1",
      };
      const readFile = vi.fn(async () => ({
        canonicalPath: "/remote/workspace/README.md",
        contentBase64: "cmVhZG1l",
        hash: "a".repeat(64),
        mode: "81a4",
        modifiedAtMs: 1,
        size: 6,
        truncated: false,
      }));
      const writeFile = vi.fn(async () => ({
        operation: "write",
        canonicalPath: "/remote/workspace/new.txt",
        bytesWritten: 3,
        hash: "c".repeat(64),
        mode: "81a4",
        modifiedAtMs: 3,
        size: 3,
        idempotencyOutcome: "executed",
      }));
      const requestControllerWorkspace = vi.fn(
        async (operation: string) =>
          operation === "localWriteFile"
            ? {
                operation: "write",
                canonicalPath: "/local/reference/local.txt",
                bytesWritten: 3,
                hash: "d".repeat(64),
                mode: "81a4",
                modifiedAtMs: 4,
                size: 3,
              }
            : {
                canonicalPath: "/local/reference/notes.md",
                contentBase64: "bG9jYWw=",
                hash: "b".repeat(64),
                mode: "81a4",
                modifiedAtMs: 2,
                size: 5,
                truncated: false,
              },
      );
      const executor = {
        connectionId: "conn-test",
        readFile,
        requestControllerWorkspace,
        writeFile,
      } as unknown as OpenSshExecutor;
      const router = new DynamicToolRouter(config, executor, new AuditLog(auditPath));

      const response = await router.handle(1, {
        arguments: {
          path: "README.md",
          rootId: "remote-project",
          target: "remote",
        },
        callId: "call-remote",
        tool: "remote_read_file",
      });
      expect(response).toMatchObject({ success: true });
      expect(parseResult(response)).toMatchObject({
        connectionId: "conn-test",
        hostId: "remote-host",
        ok: true,
        remoteCwd: "/remote/workspace",
        requestId: "call-remote",
        rootId: "remote-project",
        rootPath: "/remote/workspace",
        rootRole: "primary",
        target: "remote",
      });

      const defaulted = await router.handle(2, {
        arguments: { path: "README.md" },
        callId: "call-default",
        tool: "remote_read_file",
      });
      expect(parseResult(defaulted)).toMatchObject({
        ok: true,
        rootId: "remote-project",
        rootRole: "primary",
        target: "remote",
      });

      const denied = await router.handle(3, {
        arguments: {
          path: "notes.md",
          rootId: "context-reference",
          target: "local",
        },
        callId: "call-local",
        tool: "remote_read_file",
      }, { conversationResources: [localResource], threadId: "thread-1" });
      expect(denied).toMatchObject({ success: false });
      expect(parseResult(denied)).toMatchObject({
        error: { code: "COMMAND_DENIED" },
        ok: false,
        remoteCwd: null,
        rootId: "context-reference",
        rootPath: null,
        rootRole: "conversation",
        target: "local",
      });
      expect(readFile).toHaveBeenCalledTimes(2);

      const local = await router.handle(4, {
        arguments: {
          path: "notes.md",
          rootId: "context-reference",
          target: "local",
        },
        callId: "call-local-workspace",
        tool: "workspace_read_file",
      }, { conversationResources: [localResource], threadId: "thread-1" });
      expect(local).toMatchObject({ success: true });
      expect(parseResult(local)).toMatchObject({
        ok: true,
        remoteCwd: null,
        rootId: "context-reference",
        rootPath: "/local/reference",
        rootRole: "conversation",
        target: "local",
      });
      expect(requestControllerWorkspace).toHaveBeenCalledWith(
        "localReadFile",
        "context-reference",
        { path: "notes.md", threadId: "thread-1" },
      );

      const remoteWrite = await router.handle(
        5,
        {
          arguments: {
            contentBase64: "bmV3",
            path: "new.txt",
            rootId: "remote-project",
            target: "remote",
          },
          callId: "call-remote-write",
          tool: "workspace_write_file",
        },
        { idempotencyKey: "write-key" },
      );
      expect(parseResult(remoteWrite)).toMatchObject({
        ok: true,
        data: {
          operation: "write",
          bytesWritten: 3,
          idempotencyOutcome: "executed",
        },
        rootId: "remote-project",
        target: "remote",
      });
      expect(writeFile).toHaveBeenCalledWith("new.txt", "bmV3", {
        idempotencyKey: "write-key",
        signal: undefined,
      });

      const localWrite = await router.handle(
        6,
        {
          arguments: {
            contentBase64: "bmV3",
            path: "local.txt",
            rootId: "context-reference",
            target: "local",
          },
          callId: "call-local-write",
          tool: "workspace_write_file",
        },
        {
          conversationResources: [localResource],
          idempotencyKey: "local-write-key",
          threadId: "thread-1",
        },
      );
      expect(parseResult(localWrite)).toMatchObject({
        ok: false,
        error: { code: "COMMAND_DENIED" },
        rootId: "context-reference",
        target: "local",
      });
      expect(requestControllerWorkspace).not.toHaveBeenCalledWith(
        "localWriteFile",
        expect.anything(),
        expect.anything(),
      );

      const events = (await readFileText(auditPath)).map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "workspace_read_file",
            outcome: "succeeded",
            rootId: "context-reference",
            rootRole: "conversation",
            rootPath: "/local/reference",
            target: "local",
          }),
          expect.objectContaining({
            operation: "remote_read_file",
            outcome: "succeeded",
            rootId: "remote-project",
            rootRole: "primary",
            rootPath: "/remote/workspace",
            target: "remote",
          }),
          expect.objectContaining({
            operation: "remote_read_file",
            outcome: "failed",
            rootId: "context-reference",
            rootRole: "conversation",
            rootPath: "/local/reference",
            target: "local",
          }),
          expect.objectContaining({
            operation: "workspace_write_file",
            outcome: "succeeded",
            rootId: "remote-project",
            details: expect.objectContaining({
              bytesWritten: 3,
              idempotencyOutcome: "executed",
              path: "new.txt",
            }),
          }),
        ]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

async function readFileText(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).trim().split("\n");
}
