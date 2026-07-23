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
  return "method" in message && isBlockedLocalClientMethod(message.method);
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
