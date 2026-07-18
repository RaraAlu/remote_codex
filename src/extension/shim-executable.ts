import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import { bridgeStateDir } from "../core/locations.js";

export function packagedShimName(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  if (hostPlatform === "win32") {
    return "codex-bridge-shim.exe";
  }
  if (hostPlatform === "linux") {
    return "codex-bridge-shim.cjs";
  }
  throw new BridgeError(
    "INVALID_CONFIG",
    `Codex Bridge does not support the local ${hostPlatform} extension host`,
  );
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

export function isBridgeShimPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (name !== "codex-bridge-shim.cjs" && name !== "codex-bridge-shim.exe") {
    return false;
  }
  return (
    normalized.includes("/codex-remote-bridge/bin/") ||
    normalized.includes("/zkbot.codex-vscode-remote-bridge-")
  );
}
