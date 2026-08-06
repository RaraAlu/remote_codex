import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "./rpc.js";

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  executablePath: string;
  pid: number;
  startedAtMs: number;
}

export type ProcessIdentityInspector = (
  pids: readonly number[],
) => Promise<Map<number, ProcessIdentity>>;

export function currentProcessStartedAtMs(
  nowMs = Date.now(),
  uptimeSeconds = process.uptime(),
): number {
  return Math.round(nowMs - uptimeSeconds * 1_000);
}

function uniquePids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

function parseWindowsIdentities(raw: string): Map<number, ProcessIdentity> {
  const parsed: unknown = JSON.parse(raw);
  const items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  const identities = new Map<number, ProcessIdentity>();
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.pid !== "number" ||
      !Number.isSafeInteger(item.pid) ||
      item.pid <= 0 ||
      typeof item.executablePath !== "string" ||
      !win32.isAbsolute(item.executablePath) ||
      typeof item.startedAtMs !== "number" ||
      !Number.isFinite(item.startedAtMs)
    ) {
      continue;
    }
    identities.set(item.pid, {
      executablePath: item.executablePath,
      pid: item.pid,
      startedAtMs: item.startedAtMs,
    });
  }
  return identities;
}

async function inspectWindowsProcesses(pids: readonly number[]): Promise<Map<number, ProcessIdentity>> {
  const list = uniquePids(pids);
  if (list.length === 0) {
    return new Map();
  }
  const script = [
    `$items = @(Get-Process -Id @(${list.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object {`,
    "  try {",
    "    [pscustomobject]@{",
    "      pid = $_.Id",
    "      executablePath = $_.Path",
    "      startedAtMs = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds()",
    "    }",
    "  } catch {}",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject @{ items = $items }))",
  ].join("\n");
  const powershellExecutable = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await execFileAsync(
    powershellExecutable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  return parseWindowsIdentities(stdout);
}

function linuxBootTimeSeconds(raw: string): number {
  const match = /^btime\s+(\d+)$/m.exec(raw);
  const value = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new TypeError("Linux process table did not report boot time");
  }
  return value;
}

function linuxProcessStartTicks(raw: string): number {
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) {
    throw new TypeError("Linux process stat is malformed");
  }
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
  const value = fields[19] ? Number.parseInt(fields[19], 10) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new TypeError("Linux process stat has no start time");
  }
  return value;
}

async function inspectLinuxProcesses(pids: readonly number[]): Promise<Map<number, ProcessIdentity>> {
  const list = uniquePids(pids);
  if (list.length === 0) {
    return new Map();
  }
  const [{ stdout: ticksRaw }, procStat] = await Promise.all([
    execFileAsync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 5_000,
    }),
    readFile("/proc/stat", "utf8"),
  ]);
  const ticksPerSecond = Number.parseInt(ticksRaw.trim(), 10);
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
    throw new TypeError("Linux process clock tick rate is invalid");
  }
  const bootTimeSeconds = linuxBootTimeSeconds(procStat);
  const identities = new Map<number, ProcessIdentity>();
  await Promise.all(
    list.map(async (pid) => {
      try {
        const [executablePath, stat] = await Promise.all([
          realpath(`/proc/${pid}/exe`),
          readFile(`/proc/${pid}/stat`, "utf8"),
        ]);
        const startedAtMs = Math.round(
          bootTimeSeconds * 1_000 +
            (linuxProcessStartTicks(stat) / ticksPerSecond) * 1_000,
        );
        identities.set(pid, { executablePath, pid, startedAtMs });
      } catch {
        // The process may exit while its procfs entries are being inspected.
      }
    }),
  );
  return identities;
}

export async function inspectProcessIdentities(
  pids: readonly number[],
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<Map<number, ProcessIdentity>> {
  if (hostPlatform === "win32") {
    return await inspectWindowsProcesses(pids);
  }
  if (hostPlatform === "linux") {
    return await inspectLinuxProcesses(pids);
  }
  return new Map();
}

export function processExecutablePathsEqual(
  left: string,
  right: string,
  hostPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (hostPlatform === "win32") {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}
