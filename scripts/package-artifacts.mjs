import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");

export const CONTROLLER_TARGETS = ["linux-x64", "win32-x64"];
const MANIFEST_SCHEMA_VERSION = 1;
const ARTIFACTS_DIR = resolve("artifacts");
const DIST_DIR = resolve("dist");

export function currentControllerTarget(
  platform = process.platform,
  arch = process.arch,
) {
  if (arch !== "x64") {
    return null;
  }
  return platform === "linux"
    ? "linux-x64"
    : platform === "win32"
      ? "win32-x64"
      : null;
}

export function retainedArtifactNames(controllerVersion, executorVersion) {
  return new Set([
    `codex-remote-bridge-${controllerVersion}-linux-x64.vsix`,
    `codex-remote-bridge-${controllerVersion}-win32-x64.vsix`,
    `codex-remote-bridge-executor-${executorVersion}-linux-x64.vsix`,
    "codex-remote-bridge-executor.vsix",
  ]);
}

export function validateControllerEntryNames(entries, target) {
  const names = new Set(entries);
  if ([...names].some((name) => name.startsWith("extension/artifacts/"))) {
    throw new Error("Controller VSIX contains artifact staging files");
  }
  const linuxLauncher = "extension/dist/codex-bridge-shim";
  const windowsLauncher = "extension/dist/codex-bridge-shim.exe";
  const javascriptLauncher = "extension/dist/codex-bridge-shim.cjs";
  if (!names.has("extension/dist/codex-remote-bridge-executor.vsix")) {
    throw new Error("Controller VSIX does not embed the Remote Executor package");
  }
  if (target === "linux-x64") {
    if (
      !names.has(linuxLauncher) ||
      names.has(windowsLauncher) ||
      names.has(javascriptLauncher)
    ) {
      throw new Error("Linux Controller VSIX launcher isolation is invalid");
    }
    return;
  }
  if (target === "win32-x64") {
    if (
      !names.has(windowsLauncher) ||
      names.has(linuxLauncher) ||
      names.has(javascriptLauncher)
    ) {
      throw new Error("Windows Controller VSIX launcher isolation is invalid");
    }
    return;
  }
  throw new Error(`Unsupported Controller target: ${target}`);
}

export function validateStageManifest(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact manifest must be an object");
  }
  const manifest = value;
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.controllerVersion !== expected.controllerVersion ||
    manifest.executorVersion !== expected.executorVersion ||
    manifest.target !== expected.target ||
    manifest.sourceArch !== "x64" ||
    manifest.sourcePlatform !==
      (expected.target === "win32-x64" ? "win32" : "linux") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 2
  ) {
    throw new Error(`Artifact manifest for ${expected.target} is incompatible`);
  }
  const expectedFiles = new Map([
    [
      `codex-remote-bridge-${expected.controllerVersion}-${expected.target}.vsix`,
      "controller",
    ],
    [
      `codex-remote-bridge-executor-${expected.executorVersion}-linux-x64.vsix`,
      "executor",
    ],
  ]);
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      expectedFiles.get(file.name) !== file.role ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      seen.has(file.name)
    ) {
      throw new Error(`Artifact manifest file entry for ${expected.target} is invalid`);
    }
    seen.add(file.name);
  }
  if (seen.size !== expectedFiles.size) {
    throw new Error(`Artifact manifest for ${expected.target} is incomplete`);
  }
  return manifest;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolvePromise);
    stream.once("error", reject);
  });
  return hash.digest("hex");
}

async function readZipSelected(pathOrBuffer, selectedNames) {
  const result = {
    entries: [],
    selected: new Map(),
  };
  const entryNames = new Set();
  await new Promise((resolvePromise, reject) => {
    const onZip = (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Unable to open VSIX archive"));
        return;
      }
      zip.once("error", reject);
      zip.once("end", resolvePromise);
      zip.on("entry", (entry) => {
        const segments = entry.fileName.split("/");
        if (
          entryNames.has(entry.fileName) ||
          entry.fileName.startsWith("/") ||
          entry.fileName.includes("\\") ||
          entry.fileName.includes("\0") ||
          segments.includes(".") ||
          segments.includes("..")
        ) {
          zip.close();
          reject(new Error(`VSIX archive entry is unsafe or duplicated: ${entry.fileName}`));
          return;
        }
        entryNames.add(entry.fileName);
        result.entries.push(entry.fileName);
        if (!selectedNames.has(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > 64 * 1024 * 1024) {
          zip.close();
          reject(new Error(`VSIX archive entry is too large: ${entry.fileName}`));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Unable to read ${entry.fileName}`));
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => {
            result.selected.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    };
    if (Buffer.isBuffer(pathOrBuffer)) {
      yauzl.fromBuffer(pathOrBuffer, { lazyEntries: true }, onZip);
    } else {
      yauzl.open(pathOrBuffer, { lazyEntries: true }, onZip);
    }
  });
  return result;
}

function parsePackageJson(buffer, label) {
  if (!buffer) {
    throw new Error(`${label} package.json is missing`);
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error(`${label} package.json is invalid`);
  }
}

async function inspectExecutorVsix(pathOrBuffer, expectedVersion) {
  const archive = await readZipSelected(
    pathOrBuffer,
    new Set(["extension/package.json", "extension/dist/extension.cjs"]),
  );
  const packageJson = parsePackageJson(
    archive.selected.get("extension/package.json"),
    "Remote Executor",
  );
  const implementation = archive.selected.get("extension/dist/extension.cjs");
  if (
    packageJson.version !== expectedVersion ||
    !Array.isArray(packageJson.extensionKind) ||
    packageJson.extensionKind.length !== 1 ||
    packageJson.extensionKind[0] !== "workspace" ||
    !implementation
  ) {
    throw new Error("Remote Executor VSIX metadata or implementation is invalid");
  }
  return {
    implementationHash: createHash("sha256").update(implementation).digest("hex"),
  };
}

async function inspectControllerVsix(path, target, controllerVersion, executorVersion) {
  const archive = await readZipSelected(
    path,
    new Set([
      "extension/package.json",
      "extension/dist/codex-remote-bridge-executor.vsix",
    ]),
  );
  validateControllerEntryNames(archive.entries, target);
  const packageJson = parsePackageJson(
    archive.selected.get("extension/package.json"),
    "Controller",
  );
  if (
    packageJson.version !== controllerVersion ||
    !Array.isArray(packageJson.extensionKind) ||
    packageJson.extensionKind.length !== 1 ||
    packageJson.extensionKind[0] !== "ui"
  ) {
    throw new Error(`Controller VSIX metadata for ${target} is invalid`);
  }
  const embeddedExecutor = archive.selected.get(
    "extension/dist/codex-remote-bridge-executor.vsix",
  );
  if (!embeddedExecutor) {
    throw new Error(`Controller VSIX for ${target} is missing its Executor`);
  }
  return await inspectExecutorVsix(embeddedExecutor, executorVersion);
}

async function artifactRecord(path, role) {
  const metadata = await stat(path);
  return {
    name: basename(path),
    role,
    sha256: await sha256File(path),
    size: metadata.size,
  };
}

async function readVersions() {
  const controller = JSON.parse(await readFile("package.json", "utf8"));
  const executor = JSON.parse(await readFile("remote-executor/package.json", "utf8"));
  return {
    controllerVersion: controller.version,
    executorVersion: executor.version,
  };
}

export async function cleanupHistoricalVersionedArtifacts(
  controllerVersion,
  executorVersion,
) {
  await mkdir(DIST_DIR, { recursive: true });
  const retained = retainedArtifactNames(controllerVersion, executorVersion);
  for (const entry of await readdir(DIST_DIR, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".vsix") &&
      entry.name.startsWith("codex-remote-bridge-") &&
      !retained.has(entry.name)
    ) {
      await rm(resolve(DIST_DIR, entry.name), { force: true });
    }
  }
}

async function verifyFileRecord(directory, record) {
  const path = resolve(directory, record.name);
  const metadata = await stat(path);
  if (metadata.size !== record.size || (await sha256File(path)) !== record.sha256) {
    throw new Error(`Artifact integrity check failed: ${record.name}`);
  }
  return path;
}

async function stageCurrentPlatform() {
  const target = currentControllerTarget();
  if (!target) {
    throw new Error(`Unsupported staging host: ${process.platform}-${process.arch}`);
  }
  const versions = await readVersions();
  const controllerName = `codex-remote-bridge-${versions.controllerVersion}-${target}.vsix`;
  const executorName =
    `codex-remote-bridge-executor-${versions.executorVersion}-linux-x64.vsix`;
  const controllerPath = resolve(DIST_DIR, controllerName);
  const executorPath = resolve(DIST_DIR, executorName);
  await access(controllerPath);
  await access(executorPath);
  const [controllerExecutor, standaloneExecutor] = await Promise.all([
    inspectControllerVsix(
      controllerPath,
      target,
      versions.controllerVersion,
      versions.executorVersion,
    ),
    inspectExecutorVsix(executorPath, versions.executorVersion),
  ]);
  if (controllerExecutor.implementationHash !== standaloneExecutor.implementationHash) {
    throw new Error("Controller embeds a different Remote Executor implementation");
  }

  const stageDir = resolve(
    ARTIFACTS_DIR,
    `controller-${versions.controllerVersion}-${target}`,
  );
  await rm(stageDir, { force: true, recursive: true });
  await mkdir(stageDir, { recursive: true });
  await Promise.all([
    copyFile(controllerPath, resolve(stageDir, controllerName)),
    copyFile(executorPath, resolve(stageDir, executorName)),
  ]);
  const files = await Promise.all([
    artifactRecord(resolve(stageDir, controllerName), "controller"),
    artifactRecord(resolve(stageDir, executorName), "executor"),
  ]);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceArch: process.arch,
    sourcePlatform: process.platform,
    target,
    ...versions,
    files,
  };
  await writeFile(
    resolve(stageDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  process.stdout.write(`Staged native ${target} artifacts in ${stageDir}\n`);
}

async function loadStage(directory, target, versions) {
  const manifest = validateStageManifest(
    JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")),
    { ...versions, target },
  );
  const paths = new Map();
  for (const record of manifest.files) {
    paths.set(record.role, await verifyFileRecord(directory, record));
  }
  const controller = await inspectControllerVsix(
    paths.get("controller"),
    target,
    versions.controllerVersion,
    versions.executorVersion,
  );
  const executor = await inspectExecutorVsix(
    paths.get("executor"),
    versions.executorVersion,
  );
  if (controller.implementationHash !== executor.implementationHash) {
    throw new Error(`${target} Controller embeds a different Executor implementation`);
  }
  return { controller, manifest, paths };
}

async function collectStages(stageArguments) {
  const versions = await readVersions();
  const defaults = CONTROLLER_TARGETS.map((target) =>
    resolve(
      ARTIFACTS_DIR,
      `controller-${versions.controllerVersion}-${target}`,
    ),
  );
  const directories =
    stageArguments.length === 0 ? defaults : stageArguments.map((stage) => resolve(stage));
  if (directories.length !== CONTROLLER_TARGETS.length) {
    throw new Error("Collect requires exactly one Linux and one Windows stage directory");
  }
  const directoriesByTarget = new Map();
  for (const directory of directories) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(resolve(directory, "manifest.json"), "utf8"),
      );
    } catch {
      throw new Error(`Native artifact stage is missing or invalid: ${directory}`);
    }
    if (
      !CONTROLLER_TARGETS.includes(manifest.target) ||
      directoriesByTarget.has(manifest.target)
    ) {
      throw new Error("Collect requires one distinct Linux and Windows stage");
    }
    directoriesByTarget.set(manifest.target, directory);
  }
  const loaded = await Promise.all(
    CONTROLLER_TARGETS.map((target) =>
      loadStage(directoriesByTarget.get(target), target, versions),
    ),
  );
  const executorHashes = new Set(
    loaded.map((stage) => stage.controller.implementationHash),
  );
  if (executorHashes.size !== 1) {
    throw new Error("Native stages contain different Remote Executor implementations");
  }

  await mkdir(DIST_DIR, { recursive: true });
  const collectionDir = resolve(
    DIST_DIR,
    `.collect-${process.pid}-${Date.now()}`,
  );
  await mkdir(collectionDir, { recursive: true });
  try {
    for (const stage of loaded) {
      await copyFile(
        stage.paths.get("controller"),
        resolve(collectionDir, basename(stage.paths.get("controller"))),
      );
    }
    const executorPath = loaded[0].paths.get("executor");
    const versionedExecutorName =
      `codex-remote-bridge-executor-${versions.executorVersion}-linux-x64.vsix`;
    await copyFile(executorPath, resolve(collectionDir, versionedExecutorName));
    await copyFile(
      executorPath,
      resolve(collectionDir, "codex-remote-bridge-executor.vsix"),
    );
    await verifyCollectedDirectory(collectionDir, versions);
    for (const name of retainedArtifactNames(
      versions.controllerVersion,
      versions.executorVersion,
    )) {
      await copyFile(resolve(collectionDir, name), resolve(DIST_DIR, name));
    }
    await cleanupHistoricalVersionedArtifacts(
      versions.controllerVersion,
      versions.executorVersion,
    );
    await verifyCollectedDist(versions);
  } finally {
    await rm(collectionDir, { force: true, recursive: true });
  }
  process.stdout.write("Collected and verified Linux and Windows native Controller artifacts\n");
}

async function verifyCollectedDist(versions) {
  versions ??= await readVersions();
  await verifyCollectedDirectory(DIST_DIR, versions);
}

async function verifyCollectedDirectory(directory, versions) {
  const requiredNames = retainedArtifactNames(
    versions.controllerVersion,
    versions.executorVersion,
  );
  for (const name of requiredNames) {
    try {
      await access(resolve(directory, name));
    } catch {
      throw new Error(`Collected artifact set is incomplete: missing ${name}`);
    }
  }
  const inspections = await Promise.all(
    CONTROLLER_TARGETS.map((target) =>
      inspectControllerVsix(
        resolve(
          directory,
          `codex-remote-bridge-${versions.controllerVersion}-${target}.vsix`,
        ),
        target,
        versions.controllerVersion,
        versions.executorVersion,
      ),
    ),
  );
  const versionedExecutor = resolve(
    directory,
    `codex-remote-bridge-executor-${versions.executorVersion}-linux-x64.vsix`,
  );
  const unversionedExecutor = resolve(
    directory,
    "codex-remote-bridge-executor.vsix",
  );
  const [versioned, unversioned] = await Promise.all([
    inspectExecutorVsix(versionedExecutor, versions.executorVersion),
    inspectExecutorVsix(unversionedExecutor, versions.executorVersion),
  ]);
  const hashes = new Set([
    ...inspections.map((entry) => entry.implementationHash),
    versioned.implementationHash,
    unversioned.implementationHash,
  ]);
  if (
    hashes.size !== 1 ||
    (await sha256File(versionedExecutor)) !== (await sha256File(unversionedExecutor))
  ) {
    throw new Error("Collected Remote Executor artifacts are inconsistent");
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "stage") {
    await stageCurrentPlatform();
    return;
  }
  if (mode === "collect") {
    await collectStages(process.argv.slice(3));
    return;
  }
  if (mode === "verify") {
    await verifyCollectedDist();
    process.stdout.write("Collected dist artifacts are valid\n");
    return;
  }
  throw new Error("Usage: package-artifacts.mjs <stage|collect|verify> [stage directories]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
