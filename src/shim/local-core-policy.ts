import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RpcMessage, RpcNotification, RpcRequest } from "./rpc.js";

export const REMOTE_PERMISSION_PROFILE_ID = "codex-remote-bridge";

export const BLOCKED_LOCAL_CLIENT_METHODS = new Set([
  "thread/shellCommand",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "fs/readFile",
  "fs/writeFile",
  "fs/createDirectory",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/remove",
  "fs/copy",
  "fs/watch",
  "fs/unwatch",
  "command/exec",
  "command/exec/write",
  "command/exec/terminate",
  "command/exec/resize",
  "process/spawn",
  "process/writeStdin",
  "process/kill",
  "process/resizePty",
  "fuzzyFileSearch",
  "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop",
]);

export const BLOCKED_LOCAL_SERVER_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const REMOTE_PERMISSION_OVERRIDES = [
  `default_permissions="${REMOTE_PERMISSION_PROFILE_ID}"`,
  `permissions.${REMOTE_PERMISSION_PROFILE_ID}.description="Codex Remote Bridge local-deny policy"`,
  `permissions.${REMOTE_PERMISSION_PROFILE_ID}.filesystem={":root"="deny",":minimal"="read"}`,
  `permissions.${REMOTE_PERMISSION_PROFILE_ID}.network.enabled=false`,
];

const MANAGED_ATTACHMENT_DIRECTORY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASTED_TEXT_FILE = "pasted-text.txt";
const PASTED_TEXT_REGISTRY = "pasted-text-attachments.json";
const MAX_MANAGED_ATTACHMENT_BASE64_LENGTH =
  Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4;

export type LocalAttachmentRequestKind =
  | "attachment-directory"
  | "pasted-text"
  | "registry";

export function localCodexAttachmentRoot(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const codexHome = configuredHome
    ? resolve(configuredHome)
    : join(homedir(), ".codex");
  return resolve(codexHome, "attachments");
}

function managedAttachmentPathKind(
  rawPath: unknown,
  attachmentRoot: string,
): LocalAttachmentRequestKind | null {
  if (
    typeof rawPath !== "string" ||
    rawPath.includes("\0") ||
    !isAbsolute(rawPath)
  ) {
    return null;
  }
  const root = resolve(attachmentRoot);
  const candidate = resolve(rawPath);
  const child = relative(root, candidate);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    return null;
  }
  const segments = child.split(sep);
  if (segments.length === 1 && segments[0] === PASTED_TEXT_REGISTRY) {
    return "registry";
  }
  if (
    segments.length === 1 &&
    MANAGED_ATTACHMENT_DIRECTORY.test(segments[0] ?? "")
  ) {
    return "attachment-directory";
  }
  if (
    segments.length === 2 &&
    MANAGED_ATTACHMENT_DIRECTORY.test(segments[0] ?? "") &&
    segments[1] === PASTED_TEXT_FILE
  ) {
    return "pasted-text";
  }
  return null;
}

export function allowedLocalAttachmentRequest(
  message: RpcMessage,
  attachmentRoot = localCodexAttachmentRoot(),
): LocalAttachmentRequestKind | null {
  if (!("method" in message) || !("id" in message)) {
    return null;
  }
  const params =
    typeof message.params === "object" && message.params !== null
      ? (message.params as Record<string, unknown>)
      : null;
  if (!params) {
    return null;
  }
  const kind = managedAttachmentPathKind(params.path, attachmentRoot);
  switch (message.method) {
    case "fs/readFile":
      return kind === "registry" || kind === "pasted-text" ? kind : null;
    case "fs/createDirectory":
      return kind === "attachment-directory" && params.recursive === true
        ? kind
        : null;
    case "fs/writeFile":
      return (kind === "registry" || kind === "pasted-text") &&
        typeof params.dataBase64 === "string" &&
        params.dataBase64.length <= MAX_MANAGED_ATTACHMENT_BASE64_LENGTH
        ? kind
        : null;
    case "fs/remove":
      return kind === "pasted-text" &&
        params.force === true &&
        params.recursive !== true
        ? kind
        : null;
    default:
      return null;
  }
}

export function isBlockedLocalClientMethod(method: string): boolean {
  return BLOCKED_LOCAL_CLIENT_METHODS.has(method);
}

export function isLocalClientRiskNamespace(method: string): boolean {
  return (
    method === "thread/shellCommand" ||
    method.startsWith("thread/backgroundTerminals/") ||
    method.startsWith("fs/") ||
    method.startsWith("command/exec") ||
    method.startsWith("process/") ||
    method.startsWith("fuzzyFileSearch")
  );
}

export function isBlockedLocalClientMessage(
  message: RpcMessage,
): message is RpcRequest | RpcNotification {
  return "method" in message && isLocalClientRiskNamespace(message.method);
}

export function isBlockedLocalServerApproval(request: RpcRequest): boolean {
  return BLOCKED_LOCAL_SERVER_APPROVAL_METHODS.has(request.method);
}

export function withRemoteCorePolicy(appServerArgs: readonly string[]): string[] {
  const appServerIndex = appServerArgs.indexOf("app-server");
  if (appServerIndex < 0) {
    throw new TypeError("Remote Core policy requires an app-server invocation");
  }
  const overrides = REMOTE_PERMISSION_OVERRIDES.flatMap((value) => ["-c", value]);
  return [
    ...appServerArgs.slice(0, appServerIndex),
    ...overrides,
    ...appServerArgs.slice(appServerIndex),
  ];
}
