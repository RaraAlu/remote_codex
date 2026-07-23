import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { bridgeExternalCliDir } from "../core/locations.js";
import { isRecord } from "./rpc.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";

function parseDescriptor(
  value: unknown,
  directory: string,
): ExternalCliSessionDescriptor {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
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
    ("threadId" in value && typeof value.threadId !== "string")
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

export async function discoverExternalCliSessions(
  directory = bridgeExternalCliDir(),
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
  const sessions: ExternalCliSessionDescriptor[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    try {
      const descriptor = parseDescriptor(
        JSON.parse(await readFile(`${directory}/${name}`, "utf8")) as unknown,
        directory,
      );
      if (processIsAlive(descriptor.pid)) {
        sessions.push(descriptor);
      }
    } catch {
      // Ignore stale or incomplete descriptors; the live Shim rewrites them atomically.
    }
  }
  return sessions.sort((left, right) => right.startedAtMs - left.startedAtMs);
}
