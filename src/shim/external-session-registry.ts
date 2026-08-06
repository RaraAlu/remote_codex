import { randomBytes } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { bridgeExternalCliDir } from "../core/locations.js";
import {
  inspectProcessIdentities,
  processExecutablePathsEqual,
  type ProcessIdentity,
  type ProcessIdentityInspector,
} from "./process-identity.js";
import { isRecord } from "./rpc.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";

const CURRENT_STARTED_AT_TOLERANCE_MS = 2_000;
const LEGACY_STARTED_AT_TOLERANCE_MS = 30_000;
const LEGACY_EXECUTABLE_NAMES = new Set([
  "codex-bridge-shim",
  "codex-bridge-shim.exe",
  "node",
  "node.exe",
]);

function parseDescriptor(
  value: unknown,
  directory: string,
  hostPlatform: NodeJS.Platform,
): ExternalCliSessionDescriptor {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.endpoint !== "string" ||
    !/^ws:\/\/127\.0\.0\.1:\d+$/.test(value.endpoint) ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    value.tokenEnv !== "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN" ||
    typeof value.tokenPath !== "string" ||
    !isAbsolute(value.tokenPath) ||
    resolve(value.tokenPath) !== resolve(directory, `${value.pid}.token`) ||
    typeof value.workspaceRoot !== "string" ||
    value.workspaceRoot.length === 0 ||
    ("threadId" in value && typeof value.threadId !== "string") ||
    ("executablePath" in value &&
      (typeof value.executablePath !== "string" ||
        !(hostPlatform === "win32"
          ? win32.isAbsolute(value.executablePath)
          : isAbsolute(value.executablePath)))) ||
    (value.version === 2 && typeof value.executablePath !== "string")
  ) {
    throw new TypeError("Invalid external CLI session descriptor");
  }
  return value as unknown as ExternalCliSessionDescriptor;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function descriptorMatchesProcess(
  descriptor: ExternalCliSessionDescriptor,
  identity: ProcessIdentity,
  hostPlatform: NodeJS.Platform,
): boolean {
  if (descriptor.version === 2) {
    if (
      Math.abs(descriptor.startedAtMs - identity.startedAtMs) >
      CURRENT_STARTED_AT_TOLERANCE_MS
    ) {
      return false;
    }
  } else {
    const descriptorStartupDelayMs = descriptor.startedAtMs - identity.startedAtMs;
    if (
      descriptorStartupDelayMs < 0 ||
      descriptorStartupDelayMs > LEGACY_STARTED_AT_TOLERANCE_MS
    ) {
      return false;
    }
  }
  if (descriptor.executablePath) {
    return processExecutablePathsEqual(
      descriptor.executablePath,
      identity.executablePath,
      hostPlatform,
    );
  }
  const executableName =
    hostPlatform === "win32"
      ? win32.basename(identity.executablePath)
      : basename(identity.executablePath);
  return LEGACY_EXECUTABLE_NAMES.has(executableName.toLowerCase());
}

async function removeDescriptorIfUnchanged(path: string, expected: string): Promise<void> {
  const quarantinePath = `${path}.${randomBytes(6).toString("hex")}.stale`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  let quarantined = "";
  try {
    quarantined = await readFile(quarantinePath, "utf8");
    if (quarantined !== expected) {
      try {
        await writeFile(path, quarantined, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }
  } finally {
    await rm(quarantinePath, { force: true });
  }
}

interface DescriptorCandidate {
  descriptor: ExternalCliSessionDescriptor;
  path: string;
  raw: string;
}

export async function discoverExternalCliSessions(
  directory = bridgeExternalCliDir(),
  inspectProcesses: ProcessIdentityInspector = inspectProcessIdentities,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<ExternalCliSessionDescriptor[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates: DescriptorCandidate[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    try {
      const path = join(directory, name);
      const raw = await readFile(path, "utf8");
      candidates.push({
        descriptor: parseDescriptor(JSON.parse(raw) as unknown, directory, hostPlatform),
        path,
        raw,
      });
    } catch {
      // Ignore incomplete or unsupported descriptors; a live Shim may replace them atomically.
    }
  }
  if (candidates.length === 0) {
    return [];
  }

  if (hostPlatform !== "win32" && hostPlatform !== "linux") {
    return candidates
      .map(({ descriptor }) => descriptor)
      .filter(({ pid }) => processIsAlive(pid))
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
  }

  let identities: Map<number, ProcessIdentity>;
  try {
    identities = await inspectProcesses(candidates.map(({ descriptor }) => descriptor.pid));
  } catch {
    return candidates
      .map(({ descriptor }) => descriptor)
      .filter(({ pid }) => processIsAlive(pid))
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
  }

  const sessions: ExternalCliSessionDescriptor[] = [];
  for (const candidate of candidates) {
    const identity = identities.get(candidate.descriptor.pid);
    if (
      identity &&
      descriptorMatchesProcess(candidate.descriptor, identity, hostPlatform)
    ) {
      sessions.push(candidate.descriptor);
      continue;
    }
    if (!identity && processIsAlive(candidate.descriptor.pid)) {
      continue;
    }
    await removeDescriptorIfUnchanged(candidate.path, candidate.raw).catch(() => undefined);
  }
  return sessions.sort((left, right) => right.startedAtMs - left.startedAtMs);
}
