import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fullLocalAccessRoot } from "../src/extension/full-local-access-root.js";
import { LocalWorkspaceExecutor } from "../src/extension/local-workspace-executor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("full local access", () => {
  it("exposes the local filesystem root without persisted authorization", async () => {
    const root = fullLocalAccessRoot();
    const directory = await mkdtemp(join(tmpdir(), "codex-full-local-access-"));
    directories.push(directory);
    const executor = new LocalWorkspaceExecutor(
      root.id,
      (rootId) => (rootId === root.id ? root : undefined),
      { commandTimeoutMs: 5_000, maxOutputBytes: 1024 * 1024 },
    );
    const target = join(directory, "downloaded.txt");
    const relativeTarget = relative(root.path, target);

    await expect(
      executor.writeFile(
        relativeTarget,
        Buffer.from("full local access\n").toString("base64"),
      ),
    ).resolves.toMatchObject({ operation: "write", bytesWritten: 18 });
    expect(await readFile(target, "utf8")).toBe("full local access\n");
    await expect(executor.readFile(relativeTarget)).resolves.toMatchObject({
      canonicalPath: target,
      size: 18,
    });
  });
});
