import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOrphanedWorkspaceWrites } from "../src/remote-extension/orphaned-writes.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-orphaned-write-"));
  temporaryRoots.push(root);
  return root;
}

async function writeRegistry(
  directory: string,
  ownerPid: number,
  suffix: string,
  workspaceRoot: string,
  temporaryPath: string,
): Promise<string> {
  const registry = join(
    directory,
    `codex-bridge-write-registry.${ownerPid}.${suffix}`,
  );
  await writeFile(
    registry,
    `${Buffer.from(workspaceRoot).toString("base64")}\n${Buffer.from(temporaryPath).toString("base64")}\n`,
    { mode: 0o600 },
  );
  return registry;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe("orphaned workspace write cleanup", () => {
  it("removes a dead owner's registered workspace temporary file", async () => {
    const registryDirectory = await temporaryRoot();
    const workspaceRoot = await temporaryRoot();
    const ownerPid = 424242;
    const suffix = "Ab12Cd";
    const temporaryPath = join(
      workspaceRoot,
      `.codex-bridge-write.${ownerPid}.${suffix}`,
    );
    await writeFile(temporaryPath, "partial", { mode: 0o600 });
    const registry = await writeRegistry(
      registryDirectory,
      ownerPid,
      suffix,
      workspaceRoot,
      temporaryPath,
    );

    await expect(
      cleanupOrphanedWorkspaceWrites([workspaceRoot], {
        ownerAlive: () => false,
        registryDirectory,
      }),
    ).resolves.toBe(1);
    await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(registry)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps live-owner and out-of-root records untouched", async () => {
    const registryDirectory = await temporaryRoot();
    const workspaceRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    const livePid = 525252;
    const deadPid = 626262;
    const liveSuffix = "Live01";
    const outsideSuffix = "Out001";
    const liveTemporary = join(
      workspaceRoot,
      `.codex-bridge-write.${livePid}.${liveSuffix}`,
    );
    const outsideTemporary = join(
      outsideRoot,
      `.codex-bridge-write.${deadPid}.${outsideSuffix}`,
    );
    await writeFile(liveTemporary, "live", { mode: 0o600 });
    await writeFile(outsideTemporary, "outside", { mode: 0o600 });
    const liveRegistry = await writeRegistry(
      registryDirectory,
      livePid,
      liveSuffix,
      workspaceRoot,
      liveTemporary,
    );
    const outsideRegistry = await writeRegistry(
      registryDirectory,
      deadPid,
      outsideSuffix,
      outsideRoot,
      outsideTemporary,
    );

    await expect(
      cleanupOrphanedWorkspaceWrites([workspaceRoot], {
        ownerAlive: (pid) => pid === livePid,
        registryDirectory,
      }),
    ).resolves.toBe(0);
    await expect(readFile(liveTemporary, "utf8")).resolves.toBe("live");
    await expect(readFile(outsideTemporary, "utf8")).resolves.toBe("outside");
    await expect(readFile(liveRegistry, "utf8")).resolves.toContain(
      Buffer.from(workspaceRoot).toString("base64"),
    );
    await expect(readFile(outsideRegistry, "utf8")).resolves.toContain(
      Buffer.from(outsideRoot).toString("base64"),
    );
  });
});
