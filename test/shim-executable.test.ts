import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  installOfficialShimLauncher,
  installShimExecutable,
  isBridgeShimPath,
  packagedShimName,
  renameReplacingFileWithRetry,
} from "../src/extension/shim-executable.js";

describe("platform Shim installation", () => {
  it("installs the Windows launcher into content-addressed persistent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-bridge-shim-install-"));
    const extension = join(root, "extension");
    const state = join(root, "state");
    await mkdir(join(extension, "dist"), { recursive: true });
    await writeFile(join(extension, "dist", "codex-bridge-shim.exe"), "windows-launcher");
    const context = {
      asAbsolutePath: (relative: string) => join(extension, relative),
      extension: { packageJSON: { version: "0.2.0" } },
    } as unknown as vscode.ExtensionContext;

    const installed = await installShimExecutable(context, "win32", state);
    expect(installed).toMatch(/codex-bridge-shim\.exe$/);
    expect(await readFile(installed, "utf8")).toBe("windows-launcher");
    await expect(installShimExecutable(context, "win32", state)).resolves.toBe(installed);
  });

  it("selects only supported local UI host launchers", () => {
    expect(packagedShimName("win32")).toBe("codex-bridge-shim.exe");
    expect(packagedShimName("linux")).toBe("codex-bridge-shim");
    expect(() => packagedShimName("darwin")).toThrow(/does not support/);
  });

  it("installs the self-contained Linux launcher without a script suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-bridge-linux-shim-install-"));
    const extension = join(root, "extension");
    const state = join(root, "state");
    await mkdir(join(extension, "dist"), { recursive: true });
    await writeFile(join(extension, "dist", "codex-bridge-shim"), "linux-launcher");
    const context = {
      asAbsolutePath: (relative: string) => join(extension, relative),
      extension: { packageJSON: { version: "0.3.48" } },
    } as unknown as vscode.ExtensionContext;

    const installed = await installShimExecutable(context, "linux", state);
    expect(installed).toMatch(/codex-bridge-shim$/);
    expect(await readFile(installed, "utf8")).toBe("linux-launcher");
  });

  it("fails closed when a content-addressed launcher was modified", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-bridge-shim-tamper-"));
    const extension = join(root, "extension");
    const state = join(root, "state");
    await mkdir(join(extension, "dist"), { recursive: true });
    await writeFile(join(extension, "dist", "codex-bridge-shim.exe"), "trusted-launcher");
    const context = {
      asAbsolutePath: (relative: string) => join(extension, relative),
      extension: { packageJSON: { version: "0.2.0" } },
    } as unknown as vscode.ExtensionContext;

    const installed = await installShimExecutable(context, "win32", state);
    await writeFile(installed, "changed-launcher");
    await expect(installShimExecutable(context, "win32", state)).rejects.toThrow(
      /does not match/,
    );
  });

  it("keeps the official launcher stable while advancing its current Shim target", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-bridge-official-launcher-"));
    const extension = join(root, "extension");
    const state = join(root, "codex-remote-bridge");
    const packaged = join(extension, "dist", "codex-bridge-shim.exe");
    await mkdir(join(extension, "dist"), { recursive: true });
    await writeFile(packaged, "bootstrap-with-router");
    const context = {
      asAbsolutePath: (relative: string) => join(extension, relative),
      extension: { packageJSON: { version: "0.3.65" } },
    } as unknown as vscode.ExtensionContext;

    const launcher = await installOfficialShimLauncher(context, "win32", state, 1001);
    const firstPointer = JSON.parse(
      await readFile(join(state, "bin", "official-launcher-v1", "current.json"), "utf8"),
    ) as { extensionHostPid: number; shimPath: string };
    expect(await readFile(launcher, "utf8")).toBe("bootstrap-with-router");
    expect(firstPointer.extensionHostPid).toBe(1001);
    expect(firstPointer.shimPath).toContain("0.3.65-");

    await writeFile(packaged, "new-shim-behavior");
    (context.extension.packageJSON as { version: string }).version = "0.3.66";
    const unchangedLauncher = await installOfficialShimLauncher(
      context,
      "win32",
      state,
      1002,
    );
    const secondPointer = JSON.parse(
      await readFile(join(state, "bin", "official-launcher-v1", "current.json"), "utf8"),
    ) as { extensionHostPid: number; shimPath: string };
    expect(unchangedLauncher).toBe(launcher);
    expect(await readFile(launcher, "utf8")).toBe("bootstrap-with-router");
    expect(secondPointer.extensionHostPid).toBe(1002);
    expect(secondPointer.shimPath).toContain("0.3.66-");
    expect(await readFile(secondPointer.shimPath, "utf8")).toBe("new-shim-behavior");
    expect(isBridgeShimPath(launcher)).toBe(true);
  });

  it("retries transient Windows contention while replacing the current Shim target", async () => {
    const waits: number[] = [];
    let attempts = 0;
    await renameReplacingFileWithRetry("temporary", "current.json", {
      hostPlatform: "win32",
      renameFile: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("busy"), {
            code: attempts === 1 ? "EPERM" : "EBUSY",
          });
        }
      },
      retryDelaysMs: [10, 25],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(attempts).toBe(3);
    expect(waits).toEqual([10, 25]);
  });

  it("does not hide a permanent Windows pointer replacement failure", async () => {
    let attempts = 0;
    await expect(
      renameReplacingFileWithRetry("temporary", "current.json", {
        hostPlatform: "win32",
        renameFile: async () => {
          attempts += 1;
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
        retryDelaysMs: [10],
        wait: async () => undefined,
      }),
    ).rejects.toThrow("denied");
    expect(attempts).toBe(2);
  });

  it("fails closed when the stable official launcher was modified", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-bridge-official-tamper-"));
    const extension = join(root, "extension");
    const state = join(root, "state");
    await mkdir(join(extension, "dist"), { recursive: true });
    await writeFile(join(extension, "dist", "codex-bridge-shim.exe"), "trusted-router");
    const context = {
      asAbsolutePath: (relative: string) => join(extension, relative),
      extension: { packageJSON: { version: "0.3.65" } },
    } as unknown as vscode.ExtensionContext;

    const launcher = await installOfficialShimLauncher(context, "win32", state, 1001);
    await writeFile(launcher, "changed-router");
    await expect(
      installOfficialShimLauncher(context, "win32", state, 1002),
    ).rejects.toThrow(/trusted content hash/);
  });

  it("recognizes legacy and persistent Bridge launcher paths", () => {
    expect(
      isBridgeShimPath(
        "/home/test/.vscode/extensions/zkbot.codex-vscode-remote-bridge-0.1.11/dist/codex-bridge-shim.cjs",
      ),
    ).toBe(true);
    expect(
      isBridgeShimPath(
        "/home/test/.local/state/codex-remote-bridge/bin/0.3.48/codex-bridge-shim",
      ),
    ).toBe(true);
    expect(
      isBridgeShimPath(
        "C:\\Users\\test\\AppData\\Local\\codex-remote-bridge\\bin\\0.2.0\\codex-bridge-shim.exe",
      ),
    ).toBe(true);
    expect(
      isBridgeShimPath(
        "C:\\Users\\test\\AppData\\Local\\codex-remote-bridge\\bin\\official-launcher-v1\\codex-bridge-launcher.exe",
      ),
    ).toBe(true);
    expect(isBridgeShimPath("C:\\tools\\unrelated.exe")).toBe(false);
  });
});
