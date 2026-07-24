import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/core/audit-log.js";
import { parseBridgeConfig } from "../src/core/config.js";
import type { OpenSshExecutor } from "../src/core/ssh-executor.js";
import { DynamicToolRouter } from "../src/shim/dynamic-tools.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("remote_exec idempotency context", () => {
  it("passes the stable key to the executor and audits a replay outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-idempotency-audit-"));
    directories.push(directory);
    const auditPath = join(directory, "audit.jsonl");
    const execute = vi.fn(async () => ({
      actualCwd: "/workspace",
      durationMs: 3,
      exitCode: 0,
      idempotencyOutcome: "replayed" as const,
      signal: null,
      stderr: "",
      stdout: "done",
      truncated: false,
    }));
    const executor = {
      connectionId: "connection-1",
      execute,
    } as unknown as OpenSshExecutor;
    const router = new DynamicToolRouter(
      parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/workspace",
      }),
      executor,
      new AuditLog(auditPath),
    );

    await expect(
      router.handle(
        "request-1",
        {
          arguments: { argv: ["printf", "done"] },
          callId: "call-1",
          tool: "remote_exec",
        },
        { idempotencyKey: "stable-key" },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledWith(
      ["printf", "done"],
      expect.objectContaining({
        idempotencyKey: "stable-key",
        sideEffect: true,
      }),
    );
    const audit = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit).toContainEqual(
      expect.objectContaining({
        details: { idempotencyOutcome: "replayed" },
        operation: "remote_exec",
        outcome: "succeeded",
      }),
    );
  });
});
