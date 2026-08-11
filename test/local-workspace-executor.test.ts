import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRootAuthority } from "../src/extension/local-root-authority.js";
import { LocalWorkspaceExecutor } from "../src/extension/local-workspace-executor.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

function state(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) =>
      (values.has(key) ? values.get(key) : fallback) as T,
    keys: () => [...values.keys()],
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalWorkspaceExecutor", () => {
  it.skipIf(process.platform === "win32")(
    "reads, lists, searches, reports status, and observes revocation",
    async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-bridge-local-executor-"));
    directories.push(parent);
    const rootPath = join(parent, "authorized");
    const sourcePath = join(rootPath, "src");
    await mkdir(sourcePath, { recursive: true });
    await writeFile(join(rootPath, "README.md"), "hello local root\n", "utf8");
    await writeFile(join(sourcePath, "main.ts"), "export const answer = 42;\n", "utf8");
    const authority = new LocalRootAuthority(state());
    const root = await authority.authorize(rootPath);
    const executor = new LocalWorkspaceExecutor(
      root.id,
      (rootId) => authority.find(rootId),
      {
        commandTimeoutMs: 5_000,
        maxFileBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxSearchBytes: 1024 * 1024,
      },
    );

    const read = await executor.readFile("README.md");
    expect(Buffer.from(read.contentBase64, "base64").toString("utf8")).toBe(
      "hello local root\n",
    );
    expect(read).toMatchObject({
      canonicalPath: join(rootPath, "README.md"),
      hash: createHash("sha256").update("hello local root\n").digest("hex"),
      size: 17,
      truncated: false,
    });
    await expect(executor.listDirectory(".")).resolves.toEqual([
      { name: "README.md", type: "file" },
      { name: "src", type: "directory" },
    ]);
    await expect(executor.listTree(".", 2, 20)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        { path: "README.md", type: "file" },
        { path: "src", type: "directory" },
        { path: join("src", "main.ts"), type: "file" },
      ]),
      truncated: false,
    });
    await expect(executor.search("answer = 42")).resolves.toEqual([
      {
        path: join(sourcePath, "main.ts"),
        lineNumber: 1,
        lines: "export const answer = 42;",
      },
    ]);

    await execFileAsync("git", ["init", "--quiet", rootPath]);
    const status = await executor.gitStatus();
    expect(status).toMatchObject({
      actualCwd: rootPath,
      exitCode: 0,
      truncated: false,
    });
    expect(status.stdout).toContain("README.md");

    await authority.revoke(root.id);
    await expect(executor.readFile("README.md")).rejects.toMatchObject({
      code: "COMMAND_DENIED",
    });
  });

  it("rejects parent and symlink escapes from the authorized root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-bridge-local-boundary-"));
    directories.push(parent);
    const rootPath = join(parent, "authorized");
    const outsidePath = join(parent, "outside");
    await mkdir(rootPath);
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, "secret.txt"), "outside", "utf8");
    const authority = new LocalRootAuthority(state());
    const root = await authority.authorize(rootPath);
    const executor = new LocalWorkspaceExecutor(
      root.id,
      (rootId) => authority.find(rootId),
      {
        commandTimeoutMs: 5_000,
        maxOutputBytes: 1024 * 1024,
      },
    );

    await expect(executor.canonicalPath("../outside/secret.txt")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    if (process.platform !== "win32") {
      await symlink(outsidePath, join(rootPath, "escape"));
      await expect(executor.readFile("escape/secret.txt")).rejects.toMatchObject({
        code: "PATH_OUTSIDE_ROOT",
      });
      await rm(join(rootPath, "escape"));
      await rename(rootPath, join(parent, "authorized-moved"));
      await symlink(outsidePath, rootPath);
      await expect(executor.canonicalPath(".")).rejects.toMatchObject({
        code: "COMMAND_DENIED",
      });
    }
  });

  it.skipIf(process.platform === "win32")(
    "performs bounded atomic mutations with hash conflict protection",
    async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-bridge-local-mutation-"));
    directories.push(parent);
    const rootPath = join(parent, "authorized");
    await mkdir(rootPath);
    await writeFile(join(rootPath, "note.txt"), "alpha\n", "utf8");
    const authority = new LocalRootAuthority(state());
    const root = await authority.authorize(rootPath);
    const executor = new LocalWorkspaceExecutor(
      root.id,
      (rootId) => authority.find(rootId),
      {
        commandTimeoutMs: 5_000,
        maxOutputBytes: 1024 * 1024,
      },
    );

    const original = await executor.readFile("note.txt");
    const write = await executor.writeFile(
      "note.txt",
      Buffer.from("beta\n").toString("base64"),
      { expectedHash: original.hash },
    );
    expect(write).toMatchObject({
      operation: "write",
      canonicalPath: join(rootPath, "note.txt"),
      bytesWritten: 5,
      size: 5,
    });
    await expect(
      executor.writeFile(
        "note.txt",
        Buffer.from("stale\n").toString("base64"),
        { expectedHash: original.hash },
      ),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(join(rootPath, "note.txt"), "utf8")).toBe("beta\n");

    const current = await executor.readFile("note.txt");
    const patch = await executor.applyPatch(
      "note.txt",
      [{ oldText: "beta", newText: "gamma" }],
      { expectedHash: current.hash },
    );
    expect(patch).toMatchObject({
      operation: "patch",
      bytesWritten: 6,
      size: 6,
    });
    expect(await readFile(join(rootPath, "note.txt"), "utf8")).toBe("gamma\n");
    await expect(
      executor.applyPatch(
        "note.txt",
        [{ oldText: "a", newText: "A" }],
        { expectedHash: patch.hash },
      ),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(join(rootPath, "note.txt"), "utf8")).toBe("gamma\n");

    await executor.writeFile(
      "created.txt",
      Buffer.from("new\n").toString("base64"),
    );
    await expect(
      executor.writeFile(
        "created.txt",
        Buffer.from("overwrite\n").toString("base64"),
      ),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(join(rootPath, "created.txt"), "utf8")).toBe("new\n");

    await executor.createDirectory("staging");
    const created = await executor.readFile("created.txt");
    await executor.renamePath("created.txt", "staging/moved.txt", {
      expectedHash: created.hash,
    });
    await expect(executor.canonicalPath("created.txt")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    const moved = await executor.readFile("staging/moved.txt");
    await executor.deletePath("staging/moved.txt", { expectedHash: moved.hash });
    await executor.deletePath("staging");
    await expect(executor.canonicalPath("staging")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });

    await expect(
      executor.writeFile(
        "note.txt",
        Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        { expectedHash: patch.hash },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_TRUNCATED" });
    expect(await readFile(join(rootPath, "note.txt"), "utf8")).toBe("gamma\n");

    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      process.getuid() !== 0
    ) {
      await mkdir(join(rootPath, "locked"));
      await writeFile(join(rootPath, "locked", "file.txt"), "locked\n", "utf8");
      const locked = await executor.readFile("locked/file.txt");
      await chmod(join(rootPath, "locked"), 0o500);
      try {
        await expect(
          executor.writeFile(
            "locked/file.txt",
            Buffer.from("blocked\n").toString("base64"),
            { expectedHash: locked.hash },
          ),
        ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
        expect(await readFile(join(rootPath, "locked", "file.txt"), "utf8")).toBe(
          "locked\n",
        );
      } finally {
        await chmod(join(rootPath, "locked"), 0o700);
      }
    }
  });

  it("rejects mutation symlinks and non-empty directory deletion", async () => {
    if (process.platform === "win32") {
      return;
    }
    const parent = await mkdtemp(join(tmpdir(), "codex-bridge-local-mutation-boundary-"));
    directories.push(parent);
    const rootPath = join(parent, "authorized");
    const outsidePath = join(parent, "outside");
    await mkdir(rootPath);
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, "secret.txt"), "outside", "utf8");
    await symlink(join(outsidePath, "secret.txt"), join(rootPath, "linked.txt"));
    await mkdir(join(rootPath, "non-empty"));
    await writeFile(join(rootPath, "non-empty", "child.txt"), "child", "utf8");
    const authority = new LocalRootAuthority(state());
    const root = await authority.authorize(rootPath);
    const executor = new LocalWorkspaceExecutor(
      root.id,
      (rootId) => authority.find(rootId),
      {
        commandTimeoutMs: 5_000,
        maxOutputBytes: 1024 * 1024,
      },
    );

    await expect(
      executor.writeFile(
        "linked.txt",
        Buffer.from("blocked").toString("base64"),
      ),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    await expect(executor.deletePath("linked.txt")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    await expect(executor.deletePath("non-empty")).rejects.toMatchObject({
      code: "COMMAND_DENIED",
    });
    expect(await readFile(join(outsidePath, "secret.txt"), "utf8")).toBe(
      "outside",
    );
  });
});
