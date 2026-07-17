import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const codex = process.env.CODEX_BRIDGE_CODEX_EXECUTABLE || "codex";
const versionOutput = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
const version = versionOutput.replace(/^codex-cli\s+/, "");
const tempDir = await mkdir(join(tmpdir(), `codex-bridge-schema-${process.pid}`), {
  recursive: true,
}).then(() => join(tmpdir(), `codex-bridge-schema-${process.pid}`));
const outputDir = join("protocol", version);

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
  "ServerRequest.json",
  "v1/InitializeParams.json",
  "v2/ThreadStartParams.json",
  "v2/ThreadResumeParams.json",
]) {
  await cp(join(tempDir, relativePath), join(outputDir, relativePath));
}

const metadata = {
  codexVersion: version,
  generatedAt: new Date().toISOString(),
  generator: `${codex} app-server generate-json-schema --experimental`,
};
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
packageJson.codexAppServerVersion = version;
await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

process.stdout.write(`Generated protocol subset for Codex ${version} in ${outputDir}\n`);
