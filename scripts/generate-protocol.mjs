import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findOfficialCodexRuntime } from "./official-codex.mjs";

const runtime = await findOfficialCodexRuntime();
const codex = runtime.executable;
const versionOutput = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
const version = versionOutput.replace(/^codex-cli\s+/, "");
const tempDir = await mkdtemp(join(tmpdir(), "codex-bridge-schema-"));
const outputDir = join("protocol", version);

try {
  execFileSync(
    codex,
    ["app-server", "generate-json-schema", "--experimental", "--out", tempDir],
    { stdio: "inherit" },
  );

  await mkdir(join(outputDir, "v1"), { recursive: true });
  await mkdir(join(outputDir, "v2"), { recursive: true });

  for (const relativePath of [
    "DynamicToolCallParams.json",
    "DynamicToolCallResponse.json",
    "ClientRequest.json",
    "ServerRequest.json",
    "v1/InitializeParams.json",
    "v2/ThreadForkParams.json",
    "v2/ThreadStartParams.json",
    "v2/ThreadResumeParams.json",
    "v2/ThreadSettingsUpdateParams.json",
    "v2/TurnStartParams.json",
  ]) {
    await cp(join(tempDir, relativePath), join(outputDir, relativePath));
  }
} finally {
  await rm(tempDir, { force: true, recursive: true });
}

const metadata = {
  codexVersion: version,
  generatedAt: new Date().toISOString(),
  generator: "openai.chatgpt bundled Codex app-server generate-json-schema --experimental",
  sourceExtensionVersion: runtime.extensionVersion,
};
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
packageJson.codexProtocolSnapshotVersion = version;
delete packageJson.codexAppServerVersion;
delete packageJson.officialCodexExtensionVersion;
await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
await writeFile(
  "src/core/compatibility.ts",
  [
    "// Updated by scripts/generate-protocol.mjs from the installed official extension.",
    `export const GENERATED_PROTOCOL_SNAPSHOT_VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n"),
);

process.stdout.write(
  `Generated protocol subset for openai.chatgpt ${runtime.extensionVersion} bundled Codex ${version} in ${outputDir}\n`,
);
