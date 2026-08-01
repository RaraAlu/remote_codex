import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { BridgeError } from "./errors.js";

export const OFFICIAL_SHIM_LAUNCHER_DIRECTORY = "official-launcher-v1";
export const OFFICIAL_SHIM_LAUNCHER_METADATA = "launcher.json";
export const OFFICIAL_SHIM_TARGET_POINTER = "current.json";
export const OFFICIAL_EXTENSION_HOST_PID_ENV = "CODEX_BRIDGE_EXTENSION_HOST_PID";

export interface OfficialShimTarget {
  version: 1;
  extensionHostPid: number;
  sha256: string;
  shimPath: string;
  updatedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function bridgeShimExecutableName(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  if (hostPlatform === "win32") {
    return "codex-bridge-shim.exe";
  }
  if (hostPlatform === "linux") {
    return "codex-bridge-shim";
  }
  throw new BridgeError(
    "INVALID_CONFIG",
    `Codex Bridge does not support the local ${hostPlatform} extension host`,
  );
}

export function officialShimLauncherName(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  if (hostPlatform === "win32") {
    return "codex-bridge-launcher.exe";
  }
  if (hostPlatform === "linux") {
    return "codex-bridge-launcher";
  }
  throw new BridgeError(
    "INVALID_CONFIG",
    `Codex Bridge does not support the local ${hostPlatform} extension host`,
  );
}

export function parseOfficialShimTarget(
  value: unknown,
  launcherPath: string,
  hostPlatform: NodeJS.Platform = process.platform,
): OfficialShimTarget {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.extensionHostPid) ||
    (value.extensionHostPid as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.sha256) ||
    typeof value.shimPath !== "string" ||
    !isAbsolute(value.shimPath) ||
    typeof value.updatedAtMs !== "number" ||
    !Number.isFinite(value.updatedAtMs) ||
    value.updatedAtMs <= 0
  ) {
    throw new BridgeError("INVALID_CONFIG", "Official Shim target pointer is invalid");
  }
  const binDirectory = resolve(dirname(launcherPath), "..");
  const shimPath = resolve(value.shimPath);
  const relativeTarget = relative(binDirectory, shimPath);
  if (
    !relativeTarget ||
    relativeTarget.startsWith("..") ||
    isAbsolute(relativeTarget) ||
    basename(shimPath).toLowerCase() !== bridgeShimExecutableName(hostPlatform).toLowerCase()
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "Official Shim target must be a managed content-addressed launcher",
    );
  }
  return {
    version: 1,
    extensionHostPid: value.extensionHostPid as number,
    sha256: value.sha256.toLowerCase(),
    shimPath,
    updatedAtMs: value.updatedAtMs,
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function verifyOfficialShimTarget(
  target: OfficialShimTarget,
): Promise<void> {
  if ((await sha256File(target.shimPath)) !== target.sha256) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "Official Shim target does not match its trusted content hash",
    );
  }
}

export function takeOfficialExtensionHostPid(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackPid = process.ppid,
): number {
  const raw = environment[OFFICIAL_EXTENSION_HOST_PID_ENV];
  delete environment[OFFICIAL_EXTENSION_HOST_PID_ENV];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallbackPid;
}
