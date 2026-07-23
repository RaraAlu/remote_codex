import { describe, expect, it } from "vitest";
import {
  BLOCKED_LOCAL_CLIENT_METHODS,
  BLOCKED_LOCAL_SERVER_APPROVAL_METHODS,
  isBlockedLocalClientMessage,
  isBlockedLocalServerApproval,
  REMOTE_PERMISSION_PROFILE_ID,
  withRemoteCorePolicy,
} from "../src/shim/local-core-policy.js";

describe("remote Core policy", () => {
  it("injects the local-deny named permission profile before app-server", () => {
    const args = withRemoteCorePolicy([
      "-c",
      "mcp_servers.example.enabled=true",
      "app-server",
      "--stdio",
    ]);
    const appServerIndex = args.indexOf("app-server");
    expect(args.slice(0, appServerIndex)).toContain(
      `default_permissions="${REMOTE_PERMISSION_PROFILE_ID}"`,
    );
    expect(args.slice(0, appServerIndex)).toContain(
      `permissions.${REMOTE_PERMISSION_PROFILE_ID}.network.enabled=false`,
    );
    expect(args.slice(0, appServerIndex)).toContain(
      `permissions.${REMOTE_PERMISSION_PROFILE_ID}.filesystem={":root"="deny",":minimal"="read"}`,
    );
    expect(args.slice(appServerIndex)).toEqual(["app-server", "--stdio"]);
  });

  it("rejects non app-server invocations instead of silently weakening policy", () => {
    expect(() => withRemoteCorePolicy(["exec", "pwd"])).toThrow(
      "requires an app-server invocation",
    );
  });

  it("recognizes every reviewed local client execution and filesystem method", () => {
    expect(BLOCKED_LOCAL_CLIENT_METHODS.size).toBe(25);
    for (const method of [
      "thread/shellCommand",
      "thread/backgroundTerminals/list",
      "fs/readFile",
      "fs/writeFile",
      "command/exec",
      "process/spawn",
      "fuzzyFileSearch/sessionStart",
    ]) {
      expect(isBlockedLocalClientMessage({ id: 1, method, params: {} })).toBe(true);
    }
    expect(
      isBlockedLocalClientMessage({ id: 2, method: "thread/start", params: {} }),
    ).toBe(false);
  });

  it("recognizes every local Core approval path without blocking remote tool calls", () => {
    expect(BLOCKED_LOCAL_SERVER_APPROVAL_METHODS.size).toBe(5);
    for (const method of BLOCKED_LOCAL_SERVER_APPROVAL_METHODS) {
      expect(isBlockedLocalServerApproval({ id: 1, method, params: {} })).toBe(true);
    }
    expect(
      isBlockedLocalServerApproval({
        id: 2,
        method: "item/tool/call",
        params: { tool: "remote_exec" },
      }),
    ).toBe(false);
  });
});
