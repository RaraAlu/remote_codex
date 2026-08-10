import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enableCodexInlineMentionCompatibility,
  inspectCodexInlineMentionCompatibility,
  restoreCodexInlineMentionCompatibility,
} from "../src/extension/codex-inline-mention-compatibility.js";

const roots: string[] = [];

function composerSource(): string {
  return [
    "class Composer{insertAtMention(e,t){this.insertMentionNodeFromAtMention(e,t)}insertMentionNodeInRange(e,t,n,r,i=!1){this.insert(e,t,n,r,i)}}",
    "let controller={view:{dom:{},state:{selection:{from:1,to:1},schema:{nodes:{atMention:{}}}}},insertMentionNodeInRange(){}}",
    "listen(`add-context-file`,controller.view.dom,event=>{focus(),addDescriptors([event.file])});",
  ].join(";");
}

async function fixture(version = "1.0.0"): Promise<{
  extensionPath: string;
  stateDirectory: string;
  source: string;
  target: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-inline-mention-compat-"));
  roots.push(root);
  const extensionPath = join(root, "extensions", `openai.chatgpt-${version}`);
  const assets = join(extensionPath, "webview", "assets");
  const target = join(assets, "app-initial-main.js");
  const stateDirectory = join(root, "state");
  const source = composerSource();
  await mkdir(assets, { recursive: true });
  await writeFile(target, source, "utf8");
  await writeFile(
    join(assets, "app-initial-worker.js"),
    "switch(message.type){case `add-context-file`:invalidate();break}",
    "utf8",
  );
  return { extensionPath, stateDirectory, source, target };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("official Codex inline mention compatibility", () => {
  it("patches the one composer asset, reports it, and restores exact bytes", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
    };

    await expect(enableCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "patched",
      changed: true,
      targetPath: current.target,
    });
    expect(await readFile(current.target, "utf8")).toContain(
      "codex-remote-bridge-inline-file-mention:v1:start",
    );
    await expect(enableCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "already-patched",
      changed: false,
    });
    await expect(inspectCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "already-patched",
      changed: false,
    });

    await expect(restoreCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "restored",
      changed: true,
    });
    expect(await readFile(current.target, "utf8")).toBe(current.source);
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("fails closed when no composer handler matches", async () => {
    const current = await fixture();
    await writeFile(
      current.target,
      current.source.replace("addDescriptors([event.file])", "addDescriptors(event.file)"),
      "utf8",
    );

    await expect(
      enableCodexInlineMentionCompatibility({
        extensionPath: current.extensionPath,
        extensionVersion: "1.0.0",
        stateDirectory: current.stateDirectory,
      }),
    ).resolves.toMatchObject({ status: "unsupported", changed: false });
    expect(await readdir(current.stateDirectory)).toEqual([]);
  });

  it("refuses to overwrite an externally changed patched asset", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
    };
    await enableCodexInlineMentionCompatibility(options);
    const external = `${await readFile(current.target, "utf8")};externalChange()`;
    await writeFile(current.target, external, "utf8");

    await expect(enableCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    await expect(restoreCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    expect(await readFile(current.target, "utf8")).toBe(external);
  });

  it("replaces an older managed generator output through the saved original", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
    };
    await enableCodexInlineMentionCompatibility(options);
    const metadataPath = join(current.stateDirectory, "inline-file-mention.json");
    const metadata = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as Record<string, unknown>;
    const olderPatched = `${await readFile(current.target, "utf8")}\n/* older managed generator */\n`;
    metadata.patchedSha256 = createHash("sha256")
      .update(olderPatched)
      .digest("hex");
    await writeFile(current.target, olderPatched, "utf8");
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await expect(enableCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "patched",
      changed: true,
    });
    expect(await readFile(current.target, "utf8")).not.toContain(
      "older managed generator",
    );
  });

  it("restores a safe sibling before patching an upgraded official extension", async () => {
    const current = await fixture("1.0.0");
    await enableCodexInlineMentionCompatibility({
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
    });
    const upgradedPath = join(dirname(current.extensionPath), "openai.chatgpt-1.1.0");
    const upgradedTarget = join(
      upgradedPath,
      "webview",
      "assets",
      "app-initial-main.js",
    );
    await mkdir(dirname(upgradedTarget), { recursive: true });
    await writeFile(upgradedTarget, current.source, "utf8");

    await expect(
      enableCodexInlineMentionCompatibility({
        extensionPath: upgradedPath,
        extensionVersion: "1.1.0",
        stateDirectory: current.stateDirectory,
      }),
    ).resolves.toMatchObject({ status: "patched", changed: true });
    expect(await readFile(current.target, "utf8")).toBe(current.source);
    expect(await readFile(upgradedTarget, "utf8")).toContain(
      "codex-remote-bridge-inline-file-mention:v1:start",
    );
  });

  it("does not trust a metadata target outside the official extension", async () => {
    const current = await fixture();
    const options = {
      extensionPath: current.extensionPath,
      extensionVersion: "1.0.0",
      stateDirectory: current.stateDirectory,
    };
    await enableCodexInlineMentionCompatibility(options);
    const path = join(current.stateDirectory, "inline-file-mention.json");
    const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const victim = join(dirname(current.extensionPath), "victim.js");
    await writeFile(victim, "preserve", "utf8");
    metadata.targetPath = victim;
    metadata.targetRelativePath = "../victim.js";
    await writeFile(path, JSON.stringify(metadata), "utf8");

    await expect(restoreCodexInlineMentionCompatibility(options)).resolves.toMatchObject({
      status: "conflict",
      changed: false,
    });
    expect(await readFile(victim, "utf8")).toBe("preserve");
  });
});
