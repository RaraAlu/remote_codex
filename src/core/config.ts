import { isAbsolute, normalize, posix } from "node:path";
import { BridgeError } from "./errors.js";
import type { BridgeConfig } from "./types.js";

const DEFAULTS = {
  codexExecutable: "codex",
  commandTimeoutMs: 120_000,
  connectTimeoutSeconds: 10,
  maxOutputBytes: 10 * 1024 * 1024,
  maxParallelReads: 8,
} as const;

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
    throw new BridgeError("INVALID_CONFIG", `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(candidate);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BridgeError("INVALID_CONFIG", `${name} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new BridgeError("INVALID_CONFIG", `${name} must not contain NUL`);
  }
  return value;
}

export function parseBridgeConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("INVALID_CONFIG", "Bridge configuration must be an object");
  }

  const input = value as Record<string, unknown>;
  const host = requiredString(input.host, "host").trim();
  if (
    host.startsWith("-") ||
    /[\s*?![\]]/.test(host) ||
    host.includes("/") ||
    host.includes("\\")
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "host must be a concrete OpenSSH host alias without whitespace or wildcards",
    );
  }

  const workspaceRoot = requiredString(input.workspaceRoot, "workspaceRoot");
  const normalizedRoot = posix.normalize(workspaceRoot);
  if (!posix.isAbsolute(workspaceRoot) || normalizedRoot !== workspaceRoot || workspaceRoot === "/") {
    throw new BridgeError(
      "INVALID_CONFIG",
      "workspaceRoot must be a normalized absolute POSIX path other than /",
    );
  }

  if (input.localExecution !== undefined && input.localExecution !== "deny") {
    throw new BridgeError("INVALID_CONFIG", "localExecution is fixed to deny");
  }
  if (input.connectionMode !== undefined && input.connectionMode !== "openssh") {
    throw new BridgeError("INVALID_CONFIG", "Only the openssh connection mode is supported");
  }
  if (input.remoteHelper !== undefined && input.remoteHelper !== "none") {
    throw new BridgeError("INVALID_CONFIG", "MVP remoteHelper is fixed to none");
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new BridgeError("INVALID_CONFIG", "Unsupported bridge configuration version");
  }
  if (input.maxParallelWrites !== undefined && input.maxParallelWrites !== 1) {
    throw new BridgeError("INVALID_CONFIG", "maxParallelWrites is fixed to 1");
  }

  const sshUser =
    input.sshUser === undefined || input.sshUser === null || input.sshUser === ""
      ? undefined
      : requiredString(input.sshUser, "sshUser");
  if (sshUser && (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(sshUser) || sshUser.startsWith("-"))) {
    throw new BridgeError("INVALID_CONFIG", "sshUser contains unsupported characters");
  }

  const sshPort =
    input.sshPort === undefined || input.sshPort === null
      ? undefined
      : integerInRange(input.sshPort, 22, 1, 65_535, "sshPort");

  const identityFile =
    input.identityFile === undefined || input.identityFile === null || input.identityFile === ""
      ? undefined
      : requiredString(input.identityFile, "identityFile");
  if (identityFile && (!isAbsolute(identityFile) || normalize(identityFile) !== identityFile)) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "identityFile must be a normalized absolute local path",
    );
  }

  return {
    version: 1,
    host,
    workspaceRoot,
    connectionMode: "openssh",
    localExecution: "deny",
    remoteHelper: "none",
    ...(sshUser ? { sshUser } : {}),
    ...(sshPort ? { sshPort } : {}),
    ...(identityFile ? { identityFile } : {}),
    codexExecutable:
      typeof input.codexExecutable === "string" && input.codexExecutable.trim()
        ? input.codexExecutable
        : DEFAULTS.codexExecutable,
    commandTimeoutMs: integerInRange(
      input.commandTimeoutMs,
      DEFAULTS.commandTimeoutMs,
      1_000,
      3_600_000,
      "commandTimeoutMs",
    ),
    maxOutputBytes: integerInRange(
      input.maxOutputBytes,
      DEFAULTS.maxOutputBytes,
      1_024,
      100 * 1024 * 1024,
      "maxOutputBytes",
    ),
    maxParallelReads: integerInRange(
      input.maxParallelReads,
      DEFAULTS.maxParallelReads,
      1,
      64,
      "maxParallelReads",
    ),
    maxParallelWrites: 1,
    connectTimeoutSeconds: integerInRange(
      input.connectTimeoutSeconds,
      DEFAULTS.connectTimeoutSeconds,
      1,
      120,
      "connectTimeoutSeconds",
    ),
  };
}
