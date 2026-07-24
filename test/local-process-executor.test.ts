import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { LocalProcessExecutor } from "../src/core/local-process-executor.js";

describe.skipIf(process.platform === "win32")("LocalProcessExecutor", () => {
  it("executes inside the canonical workspace without inheriting Codex secrets", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "codex-remote-executor-")));
    const executor = new LocalProcessExecutor(
      parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: workspace,
        connectionMode: "vscode-remote",
      }),
    );
    process.env.CODEX_TEST_SECRET = "must-not-leak";
    try {
      await expect(
        executor.execute([
          "sh",
          "-c",
          'printf "%s\\n%s" "$PWD" "${CODEX_TEST_SECRET-unset}"',
        ]),
      ).resolves.toMatchObject({
        actualCwd: workspace,
        exitCode: 0,
        stdout: `${workspace}\nunset`,
      });
    } finally {
      delete process.env.CODEX_TEST_SECRET;
      executor.close();
    }
  });

  it("cancels the complete POSIX process group", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "codex-cancel-tree-")));
    const childPidPath = join(workspace, "child.pid");
    const executor = new LocalProcessExecutor(
      parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: workspace,
        connectionMode: "vscode-remote",
      }),
    );
    const controller = new AbortController();
    try {
      const running = executor.execute(
        [
          "sh",
          "-c",
          `sh -c 'trap "" TERM; echo $$ > ${JSON.stringify(childPidPath)}; while :; do sleep 1; done' & wait`,
        ],
        { sideEffect: true, signal: controller.signal },
      );
      await expect
        .poll(async () => {
          try {
            return Number.parseInt(await readFile(childPidPath, "utf8"), 10);
          } catch {
            return 0;
          }
        })
        .toBeGreaterThan(0);
      const childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);

      controller.abort();
      await expect(running).rejects.toMatchObject({
        code: "CANCELLED",
        details: { sideEffectMayHaveOccurred: true },
      });
      await expect
        .poll(() => {
          try {
            process.kill(childPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        })
        .toBe(true);
    } finally {
      executor.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
