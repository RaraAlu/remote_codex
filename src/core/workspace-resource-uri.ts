import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import * as posix from "node:path/posix";
import { BridgeError } from "./errors.js";
import type { WorkspaceTarget } from "./types.js";

export const WORKSPACE_RESOURCE_SCHEME = "codex-bridge";
export const WORKSPACE_RESOURCE_AUTHORITY = "workspace";

export interface WorkspaceResourceIdentity {
  host: string;
  relativePath: string;
  revision?: string;
  rootId: string;
  target: WorkspaceTarget;
}

function invalid(message: string): never {
  throw new BridgeError("PROTOCOL_MISMATCH", message);
}

function validateIdentifier(value: string, name: string, maxLength: number): void {
  if (
    value.length < 1 ||
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    invalid(`${name} is invalid`);
  }
}

function validateRelativePath(value: string): string[] {
  if (value.length < 1 || value.length > 16_384 || value.includes("\0")) {
    invalid("Workspace resource path is invalid");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    invalid("Workspace resource path is invalid");
  }
  return segments;
}

export function buildWorkspaceResourceUri(
  identity: WorkspaceResourceIdentity,
): string {
  validateIdentifier(identity.host, "Workspace resource host", 512);
  validateIdentifier(identity.rootId, "Workspace resource rootId", 128);
  const segments = validateRelativePath(identity.relativePath);
  if (identity.target !== "local" && identity.target !== "remote") {
    invalid("Workspace resource target is invalid");
  }
  if (
    identity.revision !== undefined &&
    !/^[0-9a-f]{64}$/.test(identity.revision)
  ) {
    invalid("Workspace resource revision is invalid");
  }

  const query = new URLSearchParams({
    host: identity.host,
    target: identity.target,
  });
  if (identity.revision) {
    query.set("revision", identity.revision);
  }
  const path = [identity.rootId, ...segments].map(encodeURIComponent).join("/");
  return `${WORKSPACE_RESOURCE_SCHEME}://${WORKSPACE_RESOURCE_AUTHORITY}/${path}?${query.toString()}`;
}

export function parseWorkspaceResourceUri(uri: string): WorkspaceResourceIdentity {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    invalid("Workspace resource URI is invalid");
  }
  if (
    parsed.protocol !== `${WORKSPACE_RESOURCE_SCHEME}:` ||
    parsed.hostname !== WORKSPACE_RESOURCE_AUTHORITY ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    invalid("Workspace resource URI identity is invalid");
  }
  const allowedKeys = new Set(["host", "target", "revision"]);
  for (const key of parsed.searchParams.keys()) {
    if (!allowedKeys.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      invalid("Workspace resource URI query is invalid");
    }
  }
  if (
    parsed.searchParams.getAll("host").length !== 1 ||
    parsed.searchParams.getAll("target").length !== 1
  ) {
    invalid("Workspace resource URI query is incomplete");
  }

  let segments: string[];
  try {
    segments = parsed.pathname
      .split("/")
      .slice(1)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    invalid("Workspace resource URI path is invalid");
  }
  if (segments.some((segment) => segment.includes("/"))) {
    invalid("Workspace resource URI path is ambiguous");
  }
  const rootId = segments.shift() ?? "";
  validateIdentifier(rootId, "Workspace resource rootId", 128);
  const relativePath = segments.join("/");
  validateRelativePath(relativePath);

  const host = parsed.searchParams.get("host") ?? "";
  validateIdentifier(host, "Workspace resource host", 512);
  const target = parsed.searchParams.get("target");
  if (target !== "local" && target !== "remote") {
    invalid("Workspace resource target is invalid");
  }
  const revision = parsed.searchParams.get("revision") ?? undefined;
  if (revision !== undefined && !/^[0-9a-f]{64}$/.test(revision)) {
    invalid("Workspace resource revision is invalid");
  }
  return {
    host,
    relativePath,
    ...(revision ? { revision } : {}),
    rootId,
    target,
  };
}

export function workspaceRelativePath(
  rootPath: string,
  candidatePath: string,
  target: WorkspaceTarget,
): string {
  if (!rootPath || !candidatePath || rootPath.includes("\0") || candidatePath.includes("\0")) {
    throw new BridgeError("PATH_OUTSIDE_ROOT", "Workspace resource path is invalid");
  }

  let child: string;
  if (target === "remote") {
    if (!posix.isAbsolute(rootPath)) {
      throw new BridgeError("INVALID_CONFIG", "Remote workspace root must be absolute");
    }
    const absolute = posix.isAbsolute(candidatePath)
      ? posix.normalize(candidatePath)
      : posix.resolve(rootPath, candidatePath);
    child = posix.relative(posix.normalize(rootPath), absolute);
    if (!child || child === ".." || child.startsWith("../") || posix.isAbsolute(child)) {
      throw new BridgeError("PATH_OUTSIDE_ROOT", "Workspace resource is outside its root");
    }
    validateRelativePath(child);
    return child;
  }

  if (!isAbsolute(rootPath)) {
    throw new BridgeError("INVALID_CONFIG", "Local workspace root must be absolute");
  }
  const absolute = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(rootPath, candidatePath);
  child = relative(resolve(rootPath), absolute);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new BridgeError("PATH_OUTSIDE_ROOT", "Workspace resource is outside its root");
  }
  const portable = child.split(sep).join("/");
  validateRelativePath(portable);
  return portable;
}
