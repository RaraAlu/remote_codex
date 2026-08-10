import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enableWorkbenchDropCompatibility,
  inspectWorkbenchDropCompatibility,
  privilegedWorkbenchReplacementArguments,
  replaceWorkbenchAsset,
  restoreWorkbenchDropCompatibility,
  workbenchProductPath,
  workbenchDropTargetPath,
  type WorkbenchAssetReplacer,
} from "../src/extension/workbench-drop-compatibility.js";

const SOURCE = [
  'var la=class extends Base{constructor(e){super(e);this.element={dataset:{}};this.id=e.id,this._title=e.title}};',
  'var Close=class extends Action{constructor(e,t,i){super(e,t);this.commandService=i}static{this.ID="workbench.action.closeActiveEditor"}run(){}};Close=decorate([param(2,commandService)],Close);',
  'var Final=class extends Disposable{constructor(){super()}static{this.ID="workbench.contrib.systemWideKeybindings"}sync(){}};Final=decorate([param(0,nativeHost)],Final);register(Final.ID,Final,Lifecycle.AfterRestored);',
  'export{mainValue as main};',
].join("");

const roots: string[] = [];
const execFileAsync = promisify(execFile);

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function checksum(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
}

async function fixture(): Promise<{
  appRoot: string;
  stateDirectory: string;
  targetPath: string;
  productPath: string;
  productSource: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-workbench-drop-"));
  roots.push(root);
  const appRoot = join(root, "resources", "app");
  const stateDirectory = join(root, "state");
  const targetPath = workbenchDropTargetPath(appRoot);
  const productPath = workbenchProductPath(appRoot);
  const productSource = `${JSON.stringify(
    { checksums: { "vs/workbench/workbench.desktop.main.js": checksum(SOURCE) } },
    null,
    2,
  )}\n`;
  await mkdir(join(appRoot, "out", "vs", "workbench"), { recursive: true });
  await writeFile(targetPath, SOURCE, { encoding: "utf8", mode: 0o644 });
  await writeFile(productPath, productSource, { encoding: "utf8", mode: 0o644 });
  return { appRoot, stateDirectory, targetPath, productPath, productSource };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed VS Code Workbench drop compatibility", () => {
  it("patches once, preserves the exact original, and restores it", async () => {
    const current = await fixture();
    const options = {
      appRoot: current.appRoot,
      stateDirectory: current.stateDirectory,
    };

    await expect(enableWorkbenchDropCompatibility(options)).resolves.toMatchObject({
      status: "patched",
      changed: true,
    });
    expect(await readFile(current.targetPath, "utf8")).toContain(
      "codex-remote-bridge-workbench-drop:v1",
    );
    expect(
      JSON.parse(await readFile(current.productPath, "utf8")).checksums[
        "vs/workbench/workbench.desktop.main.js"
      ],
    ).toBe(checksum(await readFile(current.targetPath)));
    expect(await readFile(join(current.stateDirectory, "workbench.original.js"), "utf8")).toBe(
      SOURCE,
    );
    await expect(enableWorkbenchDropCompatibility(options)).resolves.toMatchObject({
      status: "already-patched",
      changed: false,
    });

    await expect(restoreWorkbenchDropCompatibility(options)).resolves.toMatchObject({
      status: "restored",
      changed: true,
    });
    expect(await readFile(current.targetPath, "utf8")).toBe(SOURCE);
    expect(await readFile(current.productPath, "utf8")).toBe(current.productSource);
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("uses the supplied replacement boundary for an elevated installation", async () => {
    const current = await fixture();
    const replaceTarget = vi.fn<WorkbenchAssetReplacer>(replaceWorkbenchAsset);

    await enableWorkbenchDropCompatibility({
      appRoot: current.appRoot,
      stateDirectory: current.stateDirectory,
      replaceTarget,
    });

    expect(replaceTarget).toHaveBeenCalledTimes(2);
    expect(replaceTarget.mock.calls.map((call) => call[0].targetPath)).toEqual([
      current.productPath,
      current.targetPath,
    ]);
  });

  it("validates both hashes inside the privileged replacement command", async () => {
    const current = await fixture();
    const replacementPath = join(current.stateDirectory, "replacement.js");
    await mkdir(current.stateDirectory, { recursive: true });
    await writeFile(replacementPath, "replacement", "utf8");
    const request = {
      expectedSha256: sha256(SOURCE),
      mode: 0o644,
      replacementSha256: sha256("replacement"),
      sourcePath: replacementPath,
      targetPath: current.targetPath,
    };
    const [executable, ...args] = privilegedWorkbenchReplacementArguments(request);
    if (!executable) {
      throw new Error("missing privileged replacement executable");
    }

    await execFileAsync(executable, args);

    expect(await readFile(current.targetPath, "utf8")).toBe("replacement");
    await writeFile(current.targetPath, "external", "utf8");
    await writeFile(replacementPath, "next", "utf8");
    const conflicting = privilegedWorkbenchReplacementArguments({
      ...request,
      replacementSha256: sha256("next"),
    });
    await expect(execFileAsync(conflicting[0]!, conflicting.slice(1))).rejects.toBeDefined();
    expect(await readFile(current.targetPath, "utf8")).toBe("external");
  });

  it("rolls the product checksum back when the Workbench replacement fails", async () => {
    const current = await fixture();
    let calls = 0;
    const replaceTarget: WorkbenchAssetReplacer = async (replacement) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("simulated Workbench replacement failure");
      }
      await replaceWorkbenchAsset(replacement);
    };

    await expect(
      enableWorkbenchDropCompatibility({
        appRoot: current.appRoot,
        stateDirectory: current.stateDirectory,
        replaceTarget,
      }),
    ).rejects.toThrow("simulated Workbench replacement failure");

    expect(calls).toBe(3);
    expect(await readFile(current.targetPath, "utf8")).toBe(SOURCE);
    expect(await readFile(current.productPath, "utf8")).toBe(current.productSource);
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("replaces an older managed generator output through the saved original", async () => {
    const current = await fixture();
    const options = {
      appRoot: current.appRoot,
      stateDirectory: current.stateDirectory,
    };
    await enableWorkbenchDropCompatibility(options);
    const metadataPath = join(current.stateDirectory, "workbench-drop.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    const olderWorkbench = Buffer.concat([
      await readFile(current.targetPath),
      Buffer.from("\n/* older managed generator */\n"),
    ]);
    const product = JSON.parse(await readFile(current.productPath, "utf8"));
    product.checksums["vs/workbench/workbench.desktop.main.js"] = checksum(olderWorkbench);
    const olderProduct = Buffer.from(`${JSON.stringify(product, null, 2)}\n`, "utf8");
    metadata.patchedSha256 = sha256(olderWorkbench);
    metadata.productPatchedSha256 = sha256(olderProduct);
    await Promise.all([
      writeFile(current.targetPath, olderWorkbench),
      writeFile(join(current.stateDirectory, "workbench.patched.js"), olderWorkbench),
      writeFile(current.productPath, olderProduct),
      writeFile(join(current.stateDirectory, "product.patched.json"), olderProduct),
      writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
    ]);

    await expect(enableWorkbenchDropCompatibility(options)).resolves.toMatchObject({
      status: "patched",
      changed: true,
    });
    expect(await readFile(current.targetPath, "utf8")).not.toContain(
      "older managed generator",
    );
    expect(
      JSON.parse(await readFile(current.productPath, "utf8")).checksums[
        "vs/workbench/workbench.desktop.main.js"
      ],
    ).toBe(checksum(await readFile(current.targetPath)));
  });

  it("refuses to overwrite an externally changed patched asset", async () => {
    const current = await fixture();
    const options = {
      appRoot: current.appRoot,
      stateDirectory: current.stateDirectory,
    };
    await enableWorkbenchDropCompatibility(options);
    const external = `${await readFile(current.targetPath, "utf8")};externalChange()`;
    await writeFile(current.targetPath, external, "utf8");

    await expect(enableWorkbenchDropCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    await expect(restoreWorkbenchDropCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    expect(await readFile(current.targetPath, "utf8")).toBe(external);
  });

  it("fails closed without managed state when the Workbench shape is unknown", async () => {
    const current = await fixture();
    await writeFile(current.targetPath, "export{}", "utf8");

    await expect(
      enableWorkbenchDropCompatibility({
        appRoot: current.appRoot,
        stateDirectory: current.stateDirectory,
      }),
    ).resolves.toMatchObject({ status: "unsupported", changed: false });
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("does not adopt an untracked managed marker without a restorable backup", async () => {
    const current = await fixture();
    await enableWorkbenchDropCompatibility({
      appRoot: current.appRoot,
      stateDirectory: current.stateDirectory,
    });
    const patched = await readFile(current.targetPath);
    await rm(current.stateDirectory, { recursive: true, force: true });
    await mkdir(current.stateDirectory, { recursive: true });
    await writeFile(current.targetPath, patched);

    await expect(
      enableWorkbenchDropCompatibility({
        appRoot: current.appRoot,
        stateDirectory: current.stateDirectory,
      }),
    ).resolves.toMatchObject({ status: "conflict", changed: false });
  });

  const installedAppRoot = "/usr/share/code/resources/app";
  it.skipIf(!existsSync(workbenchDropTargetPath(installedAppRoot)))(
    "validates the installed Workbench and its product checksum without a version gate",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "codex-installed-workbench-probe-"));
      roots.push(root);

      const result = await inspectWorkbenchDropCompatibility({
        appRoot: installedAppRoot,
        stateDirectory: join(root, "state"),
      });
      expect(["disabled", "conflict"]).toContain(result.status);
      expect(result.changed).toBe(false);
    },
  );
});
