import { BridgeError } from "../core/errors.js";
import { isRecord } from "./rpc.js";

export interface RemoteExecArguments {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  timeoutMs?: number;
}

export function parseRemoteExecArguments(value: unknown): RemoteExecArguments {
  if (!isRecord(value) || !Array.isArray(value.argv) || value.argv.length === 0) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "remote_exec argv must be a non-empty string array",
    );
  }
  const argv = value.argv.filter((entry): entry is string => typeof entry === "string");
  if (argv.length !== value.argv.length || argv.some((entry) => entry.includes("\0"))) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "remote_exec argv must contain only NUL-free strings",
    );
  }

  let env: Record<string, string | null> | undefined;
  if (value.env !== undefined) {
    if (!isRecord(value.env)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "remote_exec env must be an object");
    }
    env = {};
    for (const [key, entry] of Object.entries(value.env)) {
      if (typeof entry !== "string" && entry !== null) {
        throw new BridgeError(
          "PROTOCOL_MISMATCH",
          "remote_exec env values must be strings or null",
        );
      }
      env[key] = entry;
    }
  }

  const cwd = typeof value.cwd === "string" ? value.cwd : undefined;
  const timeoutMs =
    typeof value.timeoutMs === "number" && Number.isInteger(value.timeoutMs)
      ? Math.max(1_000, Math.min(value.timeoutMs, 3_600_000))
      : undefined;
  return {
    argv,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function quoteForDisplay(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function formatRemoteCommand(argv: readonly string[]): string {
  return argv.map(quoteForDisplay).join(" ");
}

export function formatRemoteExecRequest(request: RemoteExecArguments): string {
  if (!request.env || Object.keys(request.env).length === 0) {
    return formatRemoteCommand(request.argv);
  }
  const unsetEnvironment: string[] = [];
  const setEnvironment: string[] = [];
  for (const [key, value] of Object.entries(request.env)) {
    if (value === null) {
      unsetEnvironment.push("-u", key);
    } else {
      setEnvironment.push(`${key}=${value}`);
    }
  }
  return formatRemoteCommand([
    "env",
    ...unsetEnvironment,
    ...setEnvironment,
    ...request.argv,
  ]);
}
