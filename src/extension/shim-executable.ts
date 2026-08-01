import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import { bridgeStateDir } from "../core/locations.js";
import {
  bridgeShimExecutableName,
  OFFICIAL_SHIM_LAUNCHER_DIRECTORY,
  OFFICIAL_SHIM_LAUNCHER_METADATA,
  OFFICIAL_SHIM_TARGET_POINTER,
  officialShimLauncherName,
  sha256File,
  type OfficialShimTarget,
} from "../core/official-shim-launcher.js";

interface OfficialShimLauncherMetadata {
  version: 1;
  sha256: string;
}

interface RenameReplacingFileOptions {
  hostPlatform?: NodeJS.Platform;
  renameFile?: (source: string, destination: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800, 1_000];

export function packagedShimName(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  return bridgeShimExecutableName(hostPlatform);
}

export async function installShimExecutable(
  context: vscode.ExtensionContext,
  hostPlatform: NodeJS.Platform = process.platform,
  stateDirectory = bridgeStateDir(),
): Promise<string> {
  const name = packagedShimName(hostPlatform);
  const source = context.asAbsolutePath(join("dist", name));
  let content: Buffer;
  try {
    content = await readFile(source);
  } catch (error) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `The ${hostPlatform} Codex Bridge launcher is missing from this extension package`,
      { source },
      { cause: error },
    );
  }

  const version = String(context.extension.packageJSON.version).replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const target = join(stateDirectory, "bin", `${version}-${digest}`, name);
  await mkdir(dirname(target), { mode: 0o700, recursive: true });

  let installedContent: Buffer | null = null;
  try {
    installedContent = await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Unable to verify the installed Codex Bridge launcher",
        { target },
        { cause: error },
      );
    }
  }
  if (installedContent) {
    if (!content.equals(installedContent)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "The content-addressed Codex Bridge launcher does not match the extension package",
        { target },
      );
    }
    await chmodIfSupported(target, 0o700, hostPlatform);
    return target;
  }

  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o700 });
  await chmodIfSupported(temporary, 0o700, hostPlatform);
  await rename(temporary, target);
  await chmodIfSupported(target, 0o700, hostPlatform);
  return target;
}

export async function installOfficialShimLauncher(
  context: vscode.ExtensionContext,
  hostPlatform: NodeJS.Platform = process.platform,
  stateDirectory = bridgeStateDir(),
  extensionHostPid = process.pid,
): Promise<string> {
  const shimPath = await installShimExecutable(context, hostPlatform, stateDirectory);
  const shimContent = await readFile(shimPath);
  const shimSha256 = createHash("sha256").update(shimContent).digest("hex");
  const launcherDirectory = join(
    stateDirectory,
    "bin",
    OFFICIAL_SHIM_LAUNCHER_DIRECTORY,
  );
  const launcherPath = join(launcherDirectory, officialShimLauncherName(hostPlatform));
  const metadataPath = join(launcherDirectory, OFFICIAL_SHIM_LAUNCHER_METADATA);
  const pointerPath = join(launcherDirectory, OFFICIAL_SHIM_TARGET_POINTER);
  await mkdir(launcherDirectory, { mode: 0o700, recursive: true });
  await chmodIfSupported(launcherDirectory, 0o700, hostPlatform);

  const [launcherContent, metadata] = await Promise.all([
    readOptionalFile(launcherPath),
    readOfficialLauncherMetadata(metadataPath),
  ]);
  if (launcherContent && metadata) {
    const installedSha256 = createHash("sha256").update(launcherContent).digest("hex");
    if (installedSha256 !== metadata.sha256) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "The stable official Codex launcher does not match its trusted content hash",
        { launcherPath },
      );
    }
  } else if (!launcherContent && metadata) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "The stable official Codex launcher is missing but its metadata remains",
      { launcherPath },
    );
  } else if (launcherContent) {
    const installedSha256 = createHash("sha256").update(launcherContent).digest("hex");
    if (installedSha256 !== shimSha256) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "The existing stable official Codex launcher cannot be safely adopted",
        { launcherPath },
      );
    }
    await writeAtomicJson(
      metadataPath,
      { version: 1, sha256: installedSha256 },
      hostPlatform,
    );
  } else {
    await installImmutableLauncher(launcherPath, shimContent, hostPlatform);
    const installedSha256 = await sha256File(launcherPath);
    await writeAtomicJson(
      metadataPath,
      { version: 1, sha256: installedSha256 },
      hostPlatform,
    );
  }
  await chmodIfSupported(launcherPath, 0o700, hostPlatform);
  await chmodIfSupported(metadataPath, 0o600, hostPlatform);

  const pointer: OfficialShimTarget = {
    version: 1,
    extensionHostPid,
    sha256: shimSha256,
    shimPath,
    updatedAtMs: Date.now(),
  };
  await writeAtomicJson(pointerPath, pointer, hostPlatform);
  await chmodIfSupported(pointerPath, 0o600, hostPlatform);
  return launcherPath;
}

async function readOptionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOfficialLauncherMetadata(
  path: string,
): Promise<OfficialShimLauncherMetadata | null> {
  const content = await readOptionalFile(path);
  if (!content) {
    return null;
  }
  try {
    const value = JSON.parse(content.toString("utf8")) as Partial<OfficialShimLauncherMetadata>;
    if (value.version === 1 && /^[0-9a-f]{64}$/.test(value.sha256 ?? "")) {
      return { version: 1, sha256: value.sha256! };
    }
  } catch {
    // Invalid managed metadata fails closed below.
  }
  throw new BridgeError(
    "INVALID_CONFIG",
    "The stable official Codex launcher metadata is invalid",
    { path },
  );
}

async function installImmutableLauncher(
  launcherPath: string,
  content: Buffer,
  hostPlatform: NodeJS.Platform,
): Promise<void> {
  const temporary = `${launcherPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o700 });
    await chmodIfSupported(temporary, 0o700, hostPlatform);
    try {
      await link(temporary, launcherPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function renameReplacingFileWithRetry(
  source: string,
  destination: string,
  options: RenameReplacingFileOptions = {},
): Promise<void> {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const retryDelaysMs = options.retryDelaysMs ?? WINDOWS_RENAME_RETRY_DELAYS_MS;
  const wait =
    options.wait ??
    (async (delayMs: number) => {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
    });

  let retries = 0;
  while (true) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryDelayMs = retryDelaysMs[retries];
      if (
        hostPlatform !== "win32" ||
        !code ||
        !["EACCES", "EBUSY", "EPERM"].includes(code) ||
        retryDelayMs === undefined
      ) {
        throw error;
      }
      retries += 1;
      await wait(retryDelayMs);
    }
  }
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  hostPlatform: NodeJS.Platform,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await renameReplacingFileWithRetry(temporary, path, { hostPlatform });
  } finally {
    await rm(temporary, { force: true });
  }
}

export function isBridgeShimPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (
    name !== "codex-bridge-shim" &&
    name !== "codex-bridge-shim.cjs" &&
    name !== "codex-bridge-shim.exe" &&
    name !== "codex-bridge-launcher" &&
    name !== "codex-bridge-launcher.exe"
  ) {
    return false;
  }
  return (
    normalized.includes("/codex-remote-bridge/bin/") ||
    normalized.includes("/zkbot.codex-vscode-remote-bridge-")
  );
}
