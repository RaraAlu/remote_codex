import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationResourceAuthority } from "../src/extension/conversation-resource-authority.js";

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
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ConversationResourceAuthority", () => {
  it.skipIf(process.platform === "win32")(
    "binds an exact dropped file and directory only to the submitting thread",
    async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-conversation-resources-"));
    directories.push(root);
    const file = join(root, "manual.txt");
    const directory = join(root, "reference");
    await writeFile(file, "manual\n", "utf8");
    await mkdir(directory);
    const storage = state();
    const authority = new ConversationResourceAuthority(storage);

    await authority.stageDropped([file, directory]);
    const claim = await authority.claim("thread-a", [`${directory}/`, file]);

    expect(claim.claimed).toHaveLength(2);
    expect(claim.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: file, role: "conversation" }),
        expect.objectContaining({ kind: "directory", path: directory, role: "conversation" }),
      ]),
    );
    expect(authority.resources("thread-b")).toEqual([]);
    expect(new ConversationResourceAuthority(storage).resources("thread-a")).toEqual(
      claim.resources,
    );
  });

  it.skipIf(process.platform === "win32")(
    "does not claim an un-staged mention or leak a claimed resource to another thread",
    async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-conversation-isolation-"));
    directories.push(root);
    const dropped = join(root, "dropped.txt");
    const untrusted = join(root, "untrusted.txt");
    await writeFile(dropped, "dropped\n", "utf8");
    await writeFile(untrusted, "untrusted\n", "utf8");
    const authority = new ConversationResourceAuthority(state());

    await authority.stageDropped([dropped]);
    await expect(authority.claim("thread-a", [untrusted])).resolves.toEqual({
      claimed: [],
      resources: [],
    });
    await expect(authority.claim("thread-a", [dropped])).resolves.toMatchObject({
      claimed: [expect.objectContaining({ path: dropped })],
    });
    await authority.stageDropped([dropped]);
    await expect(authority.claim("thread-a", [dropped])).resolves.toMatchObject({
      claimed: [],
    });
    await expect(authority.claim("thread-b", [dropped])).resolves.toEqual({
      claimed: [],
      resources: [],
    });
  });

  it("has no conversation resource count limit and deletes only the selected thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-conversation-unbounded-"));
    directories.push(root);
    const paths: string[] = [];
    for (let index = 0; index < 129; index += 1) {
      const path = join(root, `resource-${index}.txt`);
      await writeFile(path, `${index}\n`, "utf8");
      paths.push(path);
    }
    const authority = new ConversationResourceAuthority(state());

    await authority.stageDropped(paths);
    const claim = await authority.claim("thread-many", paths);

    expect(claim.claimed).toHaveLength(129);
    expect(claim.resources).toHaveLength(129);
    expect(authority.summary()).toEqual({ resourceCount: 129, threadCount: 1 });
    await expect(authority.deleteThread("thread-many")).resolves.toBe(true);
    expect(authority.summary()).toEqual({ resourceCount: 0, threadCount: 0 });
  });

  it.skipIf(process.platform === "win32")(
    "serializes concurrent claims without losing either thread",
    async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-conversation-concurrent-"));
    directories.push(root);
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await Promise.all([
      writeFile(first, "first\n", "utf8"),
      writeFile(second, "second\n", "utf8"),
    ]);
    const authority = new ConversationResourceAuthority(state());
    await authority.stageDropped([first, second]);

    await Promise.all([
      authority.claim("thread-a", [first]),
      authority.claim("thread-b", [second]),
    ]);

    expect(authority.resources("thread-a")).toEqual([
      expect.objectContaining({ path: first }),
    ]);
    expect(authority.resources("thread-b")).toEqual([
      expect.objectContaining({ path: second }),
    ]);
  });
});
