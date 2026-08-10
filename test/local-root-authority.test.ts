import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRootAuthority } from "../src/extension/local-root-authority.js";

const directories: string[] = [];

function state(initial?: unknown): vscode.Memento {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set("codexRemoteBridge.localRoots.v1", initial);
  }
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

describe("LocalRootAuthority", () => {
  it("persists a canonical local secondary root and revokes it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-bridge-local-authority-"));
    directories.push(parent);
    const selected = join(parent, "reference");
    await mkdir(selected);
    const nested = join(selected, "nested");
    await mkdir(nested);
    const storage = state();
    const authority = new LocalRootAuthority(storage);
    expect(authority.availableSlots()).toBe(15);

    const root = await authority.authorize(selected);
    expect(root).toMatchObject({
      displayName: "reference",
      path: selected,
      role: "secondary",
      target: "local",
    });
    expect(root.id).toMatch(/^local-[a-f0-9]{16}$/);
    await expect(authority.authorize(selected)).resolves.toEqual(root);
    await expect(authority.authorize(nested)).resolves.toEqual(root);
    await expect(authority.findContainingDirectory(nested)).resolves.toEqual(root);
    expect(authority.roots()).toEqual([root]);
    expect(authority.availableSlots()).toBe(14);
    await expect(authority.diagnostics()).resolves.toEqual([
      { ...root, accessible: true, error: null },
    ]);

    const restored = new LocalRootAuthority(storage);
    expect(restored.find(root.id)).toEqual(root);
    await expect(restored.revoke(root.id)).resolves.toBe(true);
    expect(restored.roots()).toEqual([]);
    await expect(restored.revoke(root.id)).resolves.toBe(false);
  });

  it("fails closed when persisted authorization is malformed", () => {
    const authority = new LocalRootAuthority(
      state({
        version: 1,
        roots: [
          {
            id: "local-invalid",
            target: "local",
            role: "secondary",
            path: "../outside",
            displayName: "outside",
          },
        ],
      }),
    );

    expect(() => authority.roots()).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
  });
});
