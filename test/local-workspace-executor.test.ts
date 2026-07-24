import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
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
  it("reads, lists, searches, reports status, and observes revocation", async () => {
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
});
