import { posix, win32 } from "node:path";
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
  if (
    input.connectionMode !== undefined &&
    input.connectionMode !== "openssh" &&
    input.connectionMode !== "vscode-remote"
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "connectionMode must be vscode-remote or openssh",
    );
  }
  if (
    input.remoteHelper !== undefined &&
    input.remoteHelper !== "none" &&
    input.remoteHelper !== "vscode-extension"
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "remoteHelper must be none or vscode-extension",
    );
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new BridgeError("INVALID_CONFIG", "Unsupported bridge configuration version");
  }
  if (input.maxParallelWrites !== undefined && input.maxParallelWrites !== 1) {
    throw new BridgeError("INVALID_CONFIG", "maxParallelWrites is fixed to 1");
  }
  if (
    input.remoteMcpRouting !== undefined &&
    input.remoteMcpRouting !== "auto" &&
    input.remoteMcpRouting !== "local"
  ) {
    throw new BridgeError("INVALID_CONFIG", "remoteMcpRouting must be auto or local");
  }
  if (
    input.remoteMcpAccess !== undefined &&
    input.remoteMcpAccess !== "enabled" &&
    input.remoteMcpAccess !== "all"
  ) {
    throw new BridgeError("INVALID_CONFIG", "remoteMcpAccess must be enabled or all");
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
  const identityPathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(identityFile ?? "") ? win32 : posix;
  if (
    identityFile &&
    (!identityPathApi.isAbsolute(identityFile) ||
      identityPathApi.normalize(identityFile) !== identityFile)
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "identityFile must be a normalized absolute local path",
    );
  }

  const connectionMode = input.connectionMode === "vscode-remote" ? "vscode-remote" : "openssh";
  if (
    input.remoteHelper !== undefined &&
    input.remoteHelper !==
      (connectionMode === "vscode-remote" ? "vscode-extension" : "none")
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "remoteHelper does not match the selected connectionMode",
    );
  }
  const transportInput = input.vscodeTransport;
  let vscodeTransport: BridgeConfig["vscodeTransport"];
  if (transportInput !== undefined) {
    if (!transportInput || typeof transportInput !== "object" || Array.isArray(transportInput)) {
      throw new BridgeError("INVALID_CONFIG", "vscodeTransport must be an object");
    }
    const transport = transportInput as Record<string, unknown>;
    const endpoint = requiredString(transport.endpoint, "vscodeTransport.endpoint");
    const sessionId = requiredString(transport.sessionId, "vscodeTransport.sessionId");
    const token = requiredString(transport.token, "vscodeTransport.token");
    if (token.length < 32) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "vscodeTransport.token must contain at least 32 characters",
      );
    }
    vscodeTransport = { endpoint, sessionId, token };
  }
  if (vscodeTransport && connectionMode !== "vscode-remote") {
    throw new BridgeError(
      "INVALID_CONFIG",
      "vscodeTransport is only valid with the vscode-remote connection mode",
    );
  }

  return {
    version: 1,
    host,
    workspaceRoot,
    connectionMode,
    localExecution: "deny",
    remoteHelper: connectionMode === "vscode-remote" ? "vscode-extension" : "none",
    ...(sshUser ? { sshUser } : {}),
    ...(sshPort ? { sshPort } : {}),
    ...(identityFile ? { identityFile } : {}),
    codexExecutable:
      typeof input.codexExecutable === "string" && input.codexExecutable.trim()
        ? input.codexExecutable
        : DEFAULTS.codexExecutable,
    sshExecutable:
      typeof input.sshExecutable === "string" && input.sshExecutable.trim()
        ? input.sshExecutable
        : "ssh",
    remoteMcpRouting: input.remoteMcpRouting === "local" ? "local" : "auto",
    remoteMcpAccess: input.remoteMcpAccess === "all" ? "all" : "enabled",
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
    ...(vscodeTransport ? { vscodeTransport } : {}),
  };
}
