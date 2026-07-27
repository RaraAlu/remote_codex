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

  it.skipIf(process.platform !== "linux")(
    "cancels descendants that create their own POSIX process group",
    async () => {
      const workspace = await realpath(await mkdtemp(join(tmpdir(), "codex-cancel-detached-")));
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
            `setsid sh -c 'trap "" TERM; echo $$ > ${JSON.stringify(childPidPath)}; while :; do sleep 1; done' & wait`,
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
        await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
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
    },
  );

  it("streams stdin and performs atomic remote workspace mutations", async () => {
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "codex-remote-mutation-")),
    );
    const executor = new LocalProcessExecutor(
      parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: workspace,
        connectionMode: "vscode-remote",
        maxOutputBytes: 1024 * 1024,
      }),
    );
    try {
      await expect(
        executor.execute(["sh", "-c", "cat"], {
          stdin: Buffer.from("stdin payload"),
        }),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "stdin payload",
      });

      const created = await executor.writeFile(
        "remote.txt",
        Buffer.from("first\n").toString("base64"),
        { idempotencyKey: "create-remote" },
      );
      expect(created).toMatchObject({
        operation: "write",
        bytesWritten: 6,
        size: 6,
      });
      await expect(
        executor.writeFile(
          "remote.txt",
          Buffer.from("stale\n").toString("base64"),
        ),
      ).rejects.toMatchObject({ code: "FILE_CONFLICT" });

      const patched = await executor.applyPatch(
        "remote.txt",
        [{ oldText: "first", newText: "second" }],
        { expectedHash: created.hash, idempotencyKey: "patch-remote" },
      );
      expect(patched).toMatchObject({
        operation: "patch",
        bytesWritten: 7,
        size: 7,
      });
      expect(await readFile(join(workspace, "remote.txt"), "utf8")).toBe(
        "second\n",
      );

      await executor.createDirectory("nested", {
        idempotencyKey: "mkdir-remote",
      });
      await executor.renamePath("remote.txt", "nested/moved.txt", {
        expectedHash: patched.hash,
        idempotencyKey: "rename-remote",
      });
      const moved = await executor.readFile("nested/moved.txt");
      await executor.deletePath("nested/moved.txt", {
        expectedHash: moved.hash,
        idempotencyKey: "delete-file-remote",
      });
      await executor.deletePath("nested", {
        idempotencyKey: "delete-directory-remote",
      });
      await expect(executor.canonicalPath("nested")).rejects.toMatchObject({
        code: "PATH_OUTSIDE_ROOT",
      });
    } finally {
      executor.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
