import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  OFFICIAL_EXTENSION_HOST_PID_ENV,
  OFFICIAL_SHIM_TARGET_POINTER,
  officialShimLauncherName,
  parseOfficialShimTarget,
  verifyOfficialShimTarget,
  type OfficialShimTarget,
} from "../core/official-shim-launcher.js";

export interface WaitForOfficialShimTargetOptions {
  extensionHostPid?: number;
  hostPlatform?: NodeJS.Platform;
  launcherPath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export function isOfficialShimLauncherInvocation(
  executablePath = process.execPath,
  hostPlatform: NodeJS.Platform = process.platform,
): boolean {
  return (
    basename(executablePath).toLowerCase() ===
    officialShimLauncherName(hostPlatform).toLowerCase()
  );
}

export async function waitForOfficialShimTarget(
  options: WaitForOfficialShimTargetOptions = {},
): Promise<OfficialShimTarget> {
  const launcherPath = options.launcherPath ?? process.execPath;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const extensionHostPid = options.extensionHostPid ?? process.ppid;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const pointerPath = join(dirname(launcherPath), OFFICIAL_SHIM_TARGET_POINTER);
  let fallback: OfficialShimTarget | null = null;
  let lastError: unknown;
  while (true) {
    try {
      const target = parseOfficialShimTarget(
        JSON.parse(await readFile(pointerPath, "utf8")) as unknown,
        launcherPath,
        hostPlatform,
      );
      fallback = target;
      if (target.extensionHostPid === extensionHostPid) {
        await verifyOfficialShimTarget(target);
        return target;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (fallback) {
        await verifyOfficialShimTarget(fallback);
        return fallback;
      }
      throw lastError ?? new Error("Official Shim target pointer was not published");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
}

export async function runOfficialShimLauncher(
  args: readonly string[] = process.argv.slice(2),
  options: WaitForOfficialShimTargetOptions = {},
  spawnProcess: typeof spawn = spawn,
): Promise<number> {
  const extensionHostPid = options.extensionHostPid ?? process.ppid;
  const target = await waitForOfficialShimTarget({ ...options, extensionHostPid });
  const child = spawnProcess(target.shimPath, [...args], {
    env: {
      ...process.env,
      [OFFICIAL_EXTENSION_HOST_PID_ENV]: String(extensionHostPid),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  return await childExitCode(child);
}

async function childExitCode(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const forwardInterrupt = (): void => {
      child.kill("SIGINT");
    };
    const forwardTermination = (): void => {
      child.kill("SIGTERM");
    };
    const cleanup = (): void => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTermination);
    };
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTermination);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolvePromise(signal ? 128 : (code ?? 1));
    });
  });
}
