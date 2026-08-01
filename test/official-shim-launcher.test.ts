import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_EXTENSION_HOST_PID_ENV,
  parseOfficialShimTarget,
  takeOfficialExtensionHostPid,
} from "../src/core/official-shim-launcher.js";
import {
  isOfficialShimLauncherInvocation,
  waitForOfficialShimTarget,
} from "../src/shim/official-shim-launcher.js";

describe("stable official Shim launcher", () => {
  it("waits for the target published by the current Extension Host generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-bridge-launcher-router-"));
    const launcherDirectory = join(root, "bin", "official-launcher-v1");
    const launcherPath = join(launcherDirectory, "codex-bridge-launcher.exe");
    const targetPath = join(root, "bin", "0.3.65-digest", "codex-bridge-shim.exe");
    await mkdir(join(root, "bin", "0.3.65-digest"), { recursive: true });
    await mkdir(launcherDirectory, { recursive: true });
    await writeFile(targetPath, "current-shim");
    const sha256 = createHash("sha256").update("current-shim").digest("hex");
    const pointerPath = join(launcherDirectory, "current.json");
    await writePointer(pointerPath, targetPath, sha256, 111);

    const waiting = waitForOfficialShimTarget({
      extensionHostPid: 222,
      hostPlatform: "win32",
      launcherPath,
      pollIntervalMs: 5,
      timeoutMs: 500,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    await writePointer(pointerPath, targetPath, sha256, 222);

    await expect(waiting).resolves.toMatchObject({
      extensionHostPid: 222,
      sha256,
      shimPath: targetPath,
    });
  });

  it("rejects targets outside the managed bin directory", () => {
    const root = join(tmpdir(), "codex-bridge-launcher-invalid");
    expect(() =>
      parseOfficialShimTarget(
        {
          version: 1,
          extensionHostPid: 123,
          sha256: "a".repeat(64),
          shimPath: join(root, "outside", "codex-bridge-shim.exe"),
          updatedAtMs: Date.now(),
        },
        join(root, "state", "bin", "official-launcher-v1", "codex-bridge-launcher.exe"),
        "win32",
      ),
    ).toThrow(/managed content-addressed launcher/);
  });

  it("recognizes the special launcher basename and consumes the original host PID", () => {
    expect(
      isOfficialShimLauncherInvocation("C:\\state\\codex-bridge-launcher.exe", "win32"),
    ).toBe(true);
    expect(
      isOfficialShimLauncherInvocation("C:\\state\\codex-bridge-shim.exe", "win32"),
    ).toBe(false);
    const environment: NodeJS.ProcessEnv = {
      [OFFICIAL_EXTENSION_HOST_PID_ENV]: "456",
    };
    expect(takeOfficialExtensionHostPid(environment, 123)).toBe(456);
    expect(environment[OFFICIAL_EXTENSION_HOST_PID_ENV]).toBeUndefined();
    expect(takeOfficialExtensionHostPid({}, 123)).toBe(123);
  });
});

async function writePointer(
  pointerPath: string,
  shimPath: string,
  sha256: string,
  extensionHostPid: number,
): Promise<void> {
  await writeFile(
    pointerPath,
    `${JSON.stringify({
      version: 1,
      extensionHostPid,
      sha256,
      shimPath,
      updatedAtMs: Date.now(),
    })}\n`,
  );
}
