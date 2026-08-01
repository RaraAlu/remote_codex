import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectOfficialExtensionSource,
  reconcileOfficialExtensionCompatibility,
  restoreOfficialExtensionCompatibility,
} from "../src/extension/official-extension-compatibility.js";

const roots: string[] = [];

function officialSource(helperName = "RRe"): string {
  return [
    `async function ${helperName}(t,e){if(!t.isLocal||Rr())return t.startFileWatch(e);let r=aut(e.path);if(r==null)return t.startFileWatch(e);try{let n=cl.workspace.createFileSystemWatcher(new cl.RelativePattern(r,"**")),o=ur(),i=c=>{e.onChange({changedPaths:[c.fsPath]})};return{dispose:async()=>n.dispose()}}catch(n){return t.startFileWatch(e)}}`,
    'function aut(t){let e=cl.workspace.workspaceFolders,r=e?.find(o=>o.uri.fsPath===t);if(r!=null)return r.uri;let n=e?.filter(o=>o.uri.scheme==="vscode-remote");return n?.length===1?n[0].uri:cl.Uri.file(t)}',
    'class GitInitWatcher{async startWatch(e,r,n,o){let i=await this.options.host.startFileWatch({path:e,recursive:!1,renameEventHandling:"changed-path",watchId:`git-init-${crypto.randomUUID()}`,onChange:r});return i}}',
  ].join(";");
}

async function fixture(version = "1.0.0"): Promise<{
  extensionPath: string;
  stateDirectory: string;
  source: string;
  target: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-official-compat-"));
  roots.push(root);
  const extensionPath = join(root, "extensions", `openai.chatgpt-${version}`);
  const target = join(extensionPath, "out", "extension.js");
  const stateDirectory = join(root, "state");
  const source = officialSource();
  await mkdir(join(extensionPath, "out"), { recursive: true });
  await writeFile(target, source, "utf8");
  return { extensionPath, stateDirectory, source, target };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("official extension git-init watcher compatibility", () => {
  it("recognizes the official helper and reroutes exactly one direct git-init watcher", () => {
    const source = officialSource("Ab1");
    const inspected = inspectOfficialExtensionSource(source);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      throw new Error(`unexpected inspection result: ${JSON.stringify(inspected)}`);
    }
    expect(inspected.helperName).toBe("Ab1");
    expect(inspected.patchedSource).toContain("await Ab1(this.options.host,{path:e");
    expect(inspected.patchedSource).not.toContain(
      "await this.options.host.startFileWatch({path:e",
    );
  });

  it("patches once, preserves the exact original, and is idempotent", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32" as const,
      remoteName: "ssh-remote",
    };

    const first = await reconcileOfficialExtensionCompatibility(options);
    expect(first.status).toBe("patched");
    expect(first.changed).toBe(true);
    expect(await readFile(current.target, "utf8")).toContain(
      "await RRe(this.options.host,{path:e",
    );
    expect(
      await readFile(join(current.stateDirectory, "git-init-watcher.original.js"), "utf8"),
    ).toBe(current.source);

    const second = await reconcileOfficialExtensionCompatibility(options);
    expect(second).toMatchObject({ status: "already-patched", changed: false });
  });

  it("restores the original bytes and removes managed state", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32" as const,
      remoteName: "ssh-remote",
    };
    await reconcileOfficialExtensionCompatibility(options);

    const restored = await restoreOfficialExtensionCompatibility(options);
    expect(restored).toMatchObject({ status: "restored", changed: true });
    expect(await readFile(current.target, "utf8")).toBe(current.source);
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("fails closed when the expected remote workspace helper shape is absent", async () => {
    const current = await fixture();
    const unsupported = current.source.replace(
      '.uri.scheme==="vscode-remote"',
      '.uri.scheme==="file"',
    );
    await writeFile(current.target, unsupported, "utf8");

    const result = await reconcileOfficialExtensionCompatibility({
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32",
      remoteName: "ssh-remote",
    });
    expect(result.status).toBe("unsupported");
    expect(await readFile(current.target, "utf8")).toBe(unsupported);
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("does not overwrite an externally changed patched asset", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32" as const,
      remoteName: "ssh-remote",
    };
    await reconcileOfficialExtensionCompatibility(options);
    const external = `${await readFile(current.target, "utf8")};externalChange()`;
    await writeFile(current.target, external, "utf8");

    await expect(reconcileOfficialExtensionCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    await expect(restoreOfficialExtensionCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    expect(await readFile(current.target, "utf8")).toBe(external);
  });

  it("restores a safely related old installation before patching an upgrade", async () => {
    const current = await fixture("1.0.0");
    await reconcileOfficialExtensionCompatibility({
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32",
      remoteName: "ssh-remote",
    });
    const upgradedPath = join(dirname(current.extensionPath), "openai.chatgpt-1.1.0");
    const upgradedTarget = join(upgradedPath, "out", "extension.js");
    await mkdir(join(upgradedPath, "out"), { recursive: true });
    await writeFile(upgradedTarget, current.source, "utf8");

    const upgraded = await reconcileOfficialExtensionCompatibility({
      extensionPath: upgradedPath,
      extensionVersion: "1.1.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32",
      remoteName: "ssh-remote",
    });
    expect(upgraded).toMatchObject({ status: "patched", changed: true });
    expect(await readFile(current.target, "utf8")).toBe(current.source);
    expect(await readFile(upgradedTarget, "utf8")).toContain(
      "await RRe(this.options.host,{path:e",
    );
  });

  it("accepts an already-routed upstream source without creating a backup", async () => {
    const current = await fixture();
    const routed = current.source.replace(
      "await this.options.host.startFileWatch({path:e",
      "await RRe(this.options.host,{path:e",
    );
    await writeFile(current.target, routed, "utf8");

    const result = await reconcileOfficialExtensionCompatibility({
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32",
      remoteName: "ssh-remote",
    });
    expect(result).toMatchObject({ status: "upstream-compatible", changed: false });
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("does not inspect or modify assets outside a Windows Remote SSH window", async () => {
    const current = await fixture();
    const result = await reconcileOfficialExtensionCompatibility({
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "linux",
      remoteName: "ssh-remote",
    });
    expect(result).toMatchObject({ status: "not-applicable", changed: false });
    expect(await readFile(current.target, "utf8")).toBe(current.source);
    await expect(readdir(current.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses restoration when the managed backup hash changes", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32" as const,
      remoteName: "ssh-remote",
    };
    await reconcileOfficialExtensionCompatibility(options);
    const patched = await readFile(current.target, "utf8");
    await writeFile(join(current.stateDirectory, "git-init-watcher.original.js"), "tampered");

    const result = await restoreOfficialExtensionCompatibility(options);
    expect(result).toMatchObject({ status: "conflict", changed: false });
    expect(await readFile(current.target, "utf8")).toBe(patched);
  });

  it("does not trust a metadata target that is not derived from its extension path", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
      hostPlatform: "win32" as const,
      remoteName: "ssh-remote",
    };
    await reconcileOfficialExtensionCompatibility(options);
    const metadataPath = join(current.stateDirectory, "git-init-watcher.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    const victim = join(dirname(current.extensionPath), "victim.js");
    await writeFile(victim, "preserve", "utf8");
    metadata.targetPath = victim;
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

    const result = await restoreOfficialExtensionCompatibility(options);
    expect(result).toMatchObject({ status: "conflict", changed: false });
    expect(await readFile(victim, "utf8")).toBe("preserve");
  });
});
