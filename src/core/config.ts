import { posix, win32 } from "node:path";
import { BridgeError } from "./errors.js";
import type { BridgeConfig, WorkspaceRootConfig } from "./types.js";

const DEFAULTS = {
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

function normalizedRemoteRoot(value: unknown, name: string): string {
  const path = requiredString(value, name);
  const normalized = posix.normalize(path);
  if (!posix.isAbsolute(path) || normalized !== path || path === "/") {
    throw new BridgeError(
      "INVALID_CONFIG",
      `${name} must be a normalized absolute POSIX path other than /`,
    );
  }
  return path;
}

function normalizedLocalRoot(value: unknown, name: string): string {
  const path = requiredString(value, name);
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? win32 : posix;
  if (
    !pathApi.isAbsolute(path) ||
    pathApi.normalize(path) !== path ||
    pathApi.parse(path).root === path
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `${name} must be a normalized absolute local path other than a filesystem root`,
    );
  }
  return path;
}

export function defaultRemotePrimaryRoot(
  workspaceRoot: string,
  displayName = posix.basename(workspaceRoot),
): WorkspaceRootConfig {
  return {
    id: "remote-primary",
    target: "remote",
    role: "primary",
    path: workspaceRoot,
    displayName,
  };
}

function parseWorkspaceRoot(value: unknown, index: number): WorkspaceRootConfig {
  const name = `roots[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("INVALID_CONFIG", `${name} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const id = requiredString(input.id, `${name}.id`).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `${name}.id must contain 1-64 letters, digits, dots, underscores, or hyphens`,
    );
  }
  if (input.target !== "local" && input.target !== "remote") {
    throw new BridgeError("INVALID_CONFIG", `${name}.target must be local or remote`);
  }
  if (input.role !== "primary" && input.role !== "secondary") {
    throw new BridgeError("INVALID_CONFIG", `${name}.role must be primary or secondary`);
  }
  const displayName = requiredString(input.displayName, `${name}.displayName`).trim();
  if (displayName.length > 128) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `${name}.displayName must not exceed 128 characters`,
    );
  }
  const path =
    input.target === "remote"
      ? normalizedRemoteRoot(input.path, `${name}.path`)
      : normalizedLocalRoot(input.path, `${name}.path`);
  return {
    id,
    target: input.target,
    role: input.role,
    path,
    displayName,
  };
}

function parseWorkspaceRoots(
  input: Record<string, unknown>,
  version: 1 | 2,
): { roots: WorkspaceRootConfig[]; workspaceRoot: string } {
  if (version === 1) {
    if (input.roots !== undefined) {
      throw new BridgeError("INVALID_CONFIG", "roots require bridge configuration version 2");
    }
    const workspaceRoot = normalizedRemoteRoot(input.workspaceRoot, "workspaceRoot");
    return {
      roots: [defaultRemotePrimaryRoot(workspaceRoot)],
      workspaceRoot,
    };
  }

  if (!Array.isArray(input.roots) || input.roots.length === 0 || input.roots.length > 16) {
    throw new BridgeError("INVALID_CONFIG", "roots must contain from 1 to 16 root records");
  }
  const roots = input.roots.map(parseWorkspaceRoot);
  const rootIds = new Set<string>();
  const rootPaths = new Set<string>();
  for (const root of roots) {
    if (rootIds.has(root.id)) {
      throw new BridgeError("INVALID_CONFIG", `Duplicate root id: ${root.id}`);
    }
    rootIds.add(root.id);
    const pathIdentity = `${root.target}\0${root.path}`;
    if (rootPaths.has(pathIdentity)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Duplicate ${root.target} root path: ${root.path}`,
      );
    }
    rootPaths.add(pathIdentity);
  }
  const primaryRoots = roots.filter((root) => root.role === "primary");
  if (primaryRoots.length !== 1 || primaryRoots[0]?.target !== "remote") {
    throw new BridgeError(
      "INVALID_CONFIG",
      "roots must contain exactly one remote primary root",
    );
  }
  const workspaceRoot = primaryRoots[0].path;
  if (
    input.workspaceRoot !== undefined &&
    normalizedRemoteRoot(input.workspaceRoot, "workspaceRoot") !== workspaceRoot
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "workspaceRoot must match the remote primary root path",
    );
  }
  return { roots, workspaceRoot };
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

  if (input.version !== undefined && input.version !== 1 && input.version !== 2) {
    throw new BridgeError("INVALID_CONFIG", "Unsupported bridge configuration version");
  }
  const sourceVersion = input.version === 2 ? 2 : 1;
  const { roots, workspaceRoot } = parseWorkspaceRoots(input, sourceVersion);

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
    version: 2,
    host,
    roots,
    workspaceRoot,
    connectionMode,
    localExecution: "deny",
    remoteHelper: connectionMode === "vscode-remote" ? "vscode-extension" : "none",
    ...(sshUser ? { sshUser } : {}),
    ...(sshPort ? { sshPort } : {}),
    ...(identityFile ? { identityFile } : {}),
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
