import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  installShimExecutable,
  isBridgeShimPath,
  packagedShimName,
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
    expect(packagedShimName("linux")).toBe("codex-bridge-shim.cjs");
    expect(() => packagedShimName("darwin")).toThrow(/does not support/);
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

  it("recognizes legacy and persistent Bridge launcher paths", () => {
    expect(
      isBridgeShimPath(
        "/home/test/.vscode/extensions/zkbot.codex-vscode-remote-bridge-0.1.11/dist/codex-bridge-shim.cjs",
      ),
    ).toBe(true);
    expect(
      isBridgeShimPath(
        "C:\\Users\\test\\AppData\\Local\\codex-remote-bridge\\bin\\0.2.0\\codex-bridge-shim.exe",
      ),
    ).toBe(true);
    expect(isBridgeShimPath("C:\\tools\\unrelated.exe")).toBe(false);
  });
});
