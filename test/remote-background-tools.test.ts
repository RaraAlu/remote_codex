import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/core/audit-log.js";
import { parseBridgeConfig } from "../src/core/config.js";
import type { OpenSshExecutor } from "../src/core/ssh-executor.js";
import {
  DynamicToolRouter,
  REMOTE_DYNAMIC_TOOLS,
} from "../src/shim/dynamic-tools.js";

function parseResult(response: unknown): Record<string, unknown> {
  const value = response as {
    contentItems?: Array<{ text?: string }>;
  };
  return JSON.parse(value.contentItems?.[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;
}

describe("remote background dynamic tools", () => {
  it("exposes and routes start, status, cursor log, and cancellation", async () => {
    expect(
      REMOTE_DYNAMIC_TOOLS.filter((tool) =>
        tool.name.startsWith("remote_background_"),
      ).map((tool) => tool.name),
    ).toEqual([
      "remote_background_start",
      "remote_background_status",
      "remote_background_log",
      "remote_background_cancel",
    ]);

    const directory = await mkdtemp(join(tmpdir(), "codex-background-tools-"));
    const auditPath = join(directory, "audit.jsonl");
    const summary = {
      taskId: "placeholder",
      status: "running" as const,
      actualCwd: "/remote/workspace",
      startedAtMs: 10,
      completedAtMs: null,
      exitCode: null,
      signal: null,
      cancellationRequested: false,
      logBaseCursor: 0,
      logCursor: 3,
    };
    const startBackgroundTask = vi.fn(
      async (taskId: string) => ({ ...summary, taskId }),
    );
    const backgroundTaskStatus = vi.fn(async (taskId: string) => ({
      ...summary,
      taskId,
    }));
    const readBackgroundTaskLog = vi.fn(async (taskId: string) => ({
      task: { ...summary, taskId },
      events: [],
      nextCursor: 3,
      truncated: false,
      hasMore: false,
    }));
    const cancelBackgroundTask = vi.fn(async (taskId: string) => ({
      ...summary,
      taskId,
      status: "cancelled" as const,
      cancellationRequested: true,
    }));
    const executor = {
      connectionId: "conn-background",
      startBackgroundTask,
      backgroundTaskStatus,
      readBackgroundTaskLog,
      cancelBackgroundTask,
    } as unknown as OpenSshExecutor;
    const router = new DynamicToolRouter(
      parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/remote/workspace",
      }),
      executor,
      new AuditLog(auditPath),
    );
    const idempotencyKey = "0123456789abcdef".repeat(4);

    try {
      const started = await router.handle(
        1,
        {
          arguments: {
            argv: ["npm", "run", "check"],
            cwd: ".",
            env: { CI: "1" },
            timeoutMs: 24 * 60 * 60_000,
          },
          callId: "call-start",
          tool: "remote_background_start",
        },
        { idempotencyKey },
      );
      const taskId = `bg_${idempotencyKey.slice(0, 32)}`;
      expect(parseResult(started)).toMatchObject({
        ok: true,
        data: { status: "running", taskId },
        remoteCwd: "/remote/workspace",
      });
      expect(startBackgroundTask).toHaveBeenCalledWith(
        taskId,
        ["npm", "run", "check"],
        {
          cwd: ".",
          env: { CI: "1" },
          idempotencyKey,
          signal: undefined,
          timeoutMs: 24 * 60 * 60_000,
        },
      );

      await router.handle(2, {
        arguments: { taskId },
        callId: "call-status",
        tool: "remote_background_status",
      });
      await router.handle(3, {
        arguments: { cursor: 2, limitBytes: 1_024, taskId },
        callId: "call-log",
        tool: "remote_background_log",
      });
      await router.handle(4, {
        arguments: { taskId },
        callId: "call-cancel",
        tool: "remote_background_cancel",
      });

      expect(backgroundTaskStatus).toHaveBeenCalledWith(taskId);
      expect(readBackgroundTaskLog).toHaveBeenCalledWith(taskId, 2, 1_024);
      expect(cancelBackgroundTask).toHaveBeenCalledWith(taskId);
      const audit = await readFile(auditPath, "utf8");
      expect(audit).toContain('"operation":"remote_background_start"');
      expect(audit).toContain(`"taskId":"${taskId}"`);
      expect(audit).toContain('"taskStatus":"running"');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
