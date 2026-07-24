import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteBackgroundTasks } from "../src/remote-extension/background-tasks.js";

async function waitForStatus(
  tasks: RemoteBackgroundTasks,
  workspaceRoot: string,
  taskId: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(() => tasks.status(workspaceRoot, taskId).status, { timeout: 5_000 })
    .toBe(expected);
}

function decodedLog(
  tasks: RemoteBackgroundTasks,
  workspaceRoot: string,
  taskId: string,
): { stderr: string; stdout: string } {
  const page = tasks.log(workspaceRoot, taskId);
  const output = { stderr: "", stdout: "" };
  for (const event of page.events) {
    output[event.channel] += Buffer.from(event.contentBase64, "base64").toString(
      "utf8",
    );
  }
  return output;
}

describe.skipIf(process.platform === "win32")("remote background tasks", () => {
  it("tracks completion, separated logs, and idempotent start", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-background-"));
    const tasks = new RemoteBackgroundTasks();
    try {
      const request = {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('out'); process.stderr.write('err')",
        ],
        taskId: "task-complete",
        workspaceRoot: workspace,
      };
      await expect(tasks.start(request)).resolves.toMatchObject({
        idempotencyOutcome: "executed",
        taskId: "task-complete",
      });
      await waitForStatus(tasks, workspace, "task-complete", "completed");

      expect(decodedLog(tasks, workspace, "task-complete")).toEqual({
        stderr: "err",
        stdout: "out",
      });
      await expect(tasks.start(request)).resolves.toMatchObject({
        idempotencyOutcome: "replayed",
        status: "completed",
      });
      await expect(
        tasks.start({ ...request, argv: [process.execPath, "-e", ""] }),
      ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });

      await tasks.start({
        argv: [process.execPath, "-e", "process.exit(7)"],
        taskId: "task-failed",
        workspaceRoot: workspace,
      });
      await waitForStatus(tasks, workspace, "task-failed", "failed");
      expect(tasks.status(workspace, "task-failed")).toMatchObject({
        exitCode: 7,
        status: "failed",
      });
    } finally {
      tasks.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("cancels the process group and keeps the terminal state queryable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-background-cancel-"));
    const tasks = new RemoteBackgroundTasks();
    try {
      const request = {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        taskId: "task-cancel",
        workspaceRoot: workspace,
      };
      await tasks.start(request);
      await expect(tasks.start(request)).resolves.toMatchObject({
        idempotencyOutcome: "joined",
        status: "running",
      });
      await expect(tasks.cancel(workspace, "task-cancel")).resolves.toMatchObject({
        cancellationRequested: true,
        taskId: "task-cancel",
      });
      await waitForStatus(tasks, workspace, "task-cancel", "cancelled");
      expect(tasks.status(workspace, "missing-task")).toMatchObject({
        status: "unknown",
        taskId: "missing-task",
      });
    } finally {
      tasks.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("bounds retained logs and reports cursor truncation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-background-log-"));
    const tasks = new RemoteBackgroundTasks(undefined, { maxLogBytes: 5 });
    try {
      await tasks.start({
        argv: [process.execPath, "-e", "process.stdout.write('abcdefghij')"],
        taskId: "task-log",
        workspaceRoot: workspace,
      });
      await waitForStatus(tasks, workspace, "task-log", "completed");

      const page = tasks.log(workspace, "task-log", 0, 100);
      expect(page).toMatchObject({
        hasMore: false,
        nextCursor: 10,
        truncated: true,
      });
      expect(
        page.events
          .map((event) =>
            Buffer.from(event.contentBase64, "base64").toString("utf8"),
          )
          .join(""),
      ).toBe("fghij");
    } finally {
      tasks.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("isolates identical task ids between remote workspace roots", async () => {
    const firstWorkspace = await mkdtemp(join(tmpdir(), "codex-background-root-a-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "codex-background-root-b-"));
    const tasks = new RemoteBackgroundTasks();
    try {
      await tasks.start({
        argv: [process.execPath, "-e", "process.stdout.write('first')"],
        taskId: "shared-id",
        workspaceRoot: firstWorkspace,
      });
      await tasks.start({
        argv: [process.execPath, "-e", "process.stdout.write('second')"],
        taskId: "shared-id",
        workspaceRoot: secondWorkspace,
      });
      await waitForStatus(tasks, firstWorkspace, "shared-id", "completed");
      await waitForStatus(tasks, secondWorkspace, "shared-id", "completed");

      expect(decodedLog(tasks, firstWorkspace, "shared-id").stdout).toBe("first");
      expect(decodedLog(tasks, secondWorkspace, "shared-id").stdout).toBe("second");
    } finally {
      tasks.close();
      await rm(firstWorkspace, { force: true, recursive: true });
      await rm(secondWorkspace, { force: true, recursive: true });
    }
  });

  it("enforces capacity, times out a task, and reuses terminal capacity", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-background-capacity-"));
    const tasks = new RemoteBackgroundTasks(undefined, { maxTasks: 1 });
    try {
      await tasks.start({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        taskId: "task-timeout",
        timeoutMs: 1_000,
        workspaceRoot: workspace,
      });
      await expect(
        tasks.start({
          argv: [process.execPath, "-e", ""],
          taskId: "task-over-capacity",
          workspaceRoot: workspace,
        }),
      ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
      await waitForStatus(tasks, workspace, "task-timeout", "timed_out");

      await tasks.start({
        argv: [process.execPath, "-e", ""],
        taskId: "task-after-timeout",
        workspaceRoot: workspace,
      });
      await waitForStatus(tasks, workspace, "task-after-timeout", "completed");
      expect(tasks.status(workspace, "task-timeout").status).toBe("unknown");
    } finally {
      tasks.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("kills active tasks synchronously when the extension host closes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-background-close-"));
    const tasks = new RemoteBackgroundTasks();
    try {
      await tasks.start({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
        ],
        taskId: "task-close",
        workspaceRoot: workspace,
      });
      await expect
        .poll(() => decodedLog(tasks, workspace, "task-close").stdout)
        .toMatch(/^\d+$/);
      const pid = Number(decodedLog(tasks, workspace, "task-close").stdout);

      tasks.close();
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      tasks.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
