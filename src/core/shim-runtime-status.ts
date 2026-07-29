import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chmodIfSupported } from "./file-permissions.js";

export interface ShimRuntimeStatus {
  version: 1;
  host: string;
  workspaceRoot: string;
  shimExecutable: string;
  nodeExecutable: string | null;
  extensionHostPid: number;
  shimPid: number;
  shimStartedAtMs: number;
  running: boolean;
  shimLastExitCode: number | null;
  appServerInitializedAtMs: number | null;
  appServerLastError: string | null;
  updatedAtMs: number;
}

export interface ShimRuntimeHealth {
  nodeExecutable: string | null;
  shimExecutable: string | null;
  shimStarted: boolean;
  shimPid: number | null;
  shimStartedAtMs: number | null;
  shimLastExitCode: number | null;
  appServerInitialized: boolean;
  appServerInitializedAtMs: number | null;
  appServerLastError: string | null;
  updatedAtMs: number | null;
}

export const EMPTY_SHIM_RUNTIME_HEALTH: ShimRuntimeHealth = {
  nodeExecutable: null,
  shimExecutable: null,
  shimStarted: false,
  shimPid: null,
  shimStartedAtMs: null,
  shimLastExitCode: null,
  appServerInitialized: false,
  appServerInitializedAtMs: null,
  appServerLastError: null,
  updatedAtMs: null,
};

function optionalFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseShimRuntimeStatus(value: unknown): ShimRuntimeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Shim runtime status must be an object");
  }
  const status = value as Record<string, unknown>;
  if (
    status.version !== 1 ||
    typeof status.host !== "string" ||
    status.host.length === 0 ||
    typeof status.workspaceRoot !== "string" ||
    status.workspaceRoot.length === 0 ||
    typeof status.shimExecutable !== "string" ||
    status.shimExecutable.length === 0 ||
    (status.nodeExecutable !== null && typeof status.nodeExecutable !== "string") ||
    !Number.isSafeInteger(status.extensionHostPid) ||
    Number(status.extensionHostPid) <= 0 ||
    !Number.isSafeInteger(status.shimPid) ||
    Number(status.shimPid) <= 0 ||
    typeof status.shimStartedAtMs !== "number" ||
    !Number.isFinite(status.shimStartedAtMs) ||
    typeof status.running !== "boolean" ||
    !optionalFiniteNumber(status.shimLastExitCode) ||
    !optionalFiniteNumber(status.appServerInitializedAtMs) ||
    (status.appServerLastError !== null &&
      typeof status.appServerLastError !== "string") ||
    typeof status.updatedAtMs !== "number" ||
    !Number.isFinite(status.updatedAtMs)
  ) {
    throw new TypeError("Shim runtime status is invalid");
  }
  return status as unknown as ShimRuntimeStatus;
}

export async function saveShimRuntimeStatus(
  path: string,
  status: ShimRuntimeStatus,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmodIfSupported(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await chmodIfSupported(temporary, 0o600);
  await rename(temporary, path);
}

export async function loadShimRuntimeStatus(
  path: string,
): Promise<ShimRuntimeStatus | null> {
  try {
    return parseShimRuntimeStatus(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function shimRuntimeHealth(
  status: ShimRuntimeStatus | null,
  isProcessAlive: (pid: number) => boolean = processIsAlive,
  expectedExtensionHostPid?: number,
): ShimRuntimeHealth {
  if (!status) {
    return { ...EMPTY_SHIM_RUNTIME_HEALTH };
  }
  const shimStarted =
    status.running &&
    isProcessAlive(status.shimPid) &&
    (expectedExtensionHostPid === undefined ||
      status.extensionHostPid === expectedExtensionHostPid);
  return {
    nodeExecutable: status.nodeExecutable,
    shimExecutable: status.shimExecutable,
    shimStarted,
    shimPid: status.shimPid,
    shimStartedAtMs: status.shimStartedAtMs,
    shimLastExitCode: status.shimLastExitCode,
    appServerInitialized:
      shimStarted && status.appServerInitializedAtMs !== null,
    appServerInitializedAtMs: status.appServerInitializedAtMs,
    appServerLastError: status.appServerLastError,
    updatedAtMs: status.updatedAtMs,
  };
}
