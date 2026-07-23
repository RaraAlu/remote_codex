import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit-log.js";
import { parseBridgeConfig } from "../src/core/config.js";
import { loadBridgeConfig, saveBridgeConfig } from "../src/core/config-store.js";

describe("local configuration and audit storage", () => {
  it("atomically stores a non-secret configuration with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-config-"));
    const path = join(directory, "nested", "config.json");
    const config = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
    });
    await saveBridgeConfig(path, config);
    expect(await loadBridgeConfig(path)).toEqual(config);

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("loads a persisted v1 workspace as a v2 remote primary root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-config-v1-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        host: "training-gpu",
        workspaceRoot: "/remote/workspace",
      })}\n`,
    );

    await expect(loadBridgeConfig(path)).resolves.toMatchObject({
      version: 2,
      workspaceRoot: "/remote/workspace",
      roots: [
        {
          id: "remote-primary",
          target: "remote",
          role: "primary",
          path: "/remote/workspace",
        },
      ],
    });
  });

  it("writes redacted JSONL audit events with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-audit-"));
    const path = join(directory, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.write({
      operation: "test",
      outcome: "failed",
      details: {
        authorization: "Bearer abcdefghijklmnop",
        message: "safe",
      },
    });
    const content = await readFile(path, "utf8");
    expect(content).toContain('"authorization":"[REDACTED]"');
    expect(content).not.toContain("abcdefghijklmnop");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
