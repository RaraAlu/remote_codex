import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedLocalAttachmentRequest,
  BLOCKED_LOCAL_CLIENT_METHODS,
  BLOCKED_LOCAL_SERVER_APPROVAL_METHODS,
  isBlockedLocalClientMessage,
  isBlockedLocalServerApproval,
  REMOTE_PERMISSION_PROFILE_ID,
  withRemoteCorePolicy,
} from "../src/shim/local-core-policy.js";

describe("remote Core policy", () => {
  const attachmentRoot = resolve(".test-codex", "attachments");
  const attachmentId = "123e4567-e89b-42d3-a456-426614174000";

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
    expect(
      isBlockedLocalClientMessage({
        id: 3,
        method: "fs/futureMutation",
        params: {},
      }),
    ).toBe(true);
    expect(
      isBlockedLocalClientMessage({
        id: 4,
        method: "process/futureControl",
        params: {},
      }),
    ).toBe(true);
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

  it("allows only pasted-text operations inside the managed attachment root", () => {
    const registry = join(attachmentRoot, "pasted-text-attachments.json");
    const directory = join(attachmentRoot, attachmentId);
    const pastedText = join(directory, "pasted-text.txt");
    expect(
      allowedLocalAttachmentRequest(
        { id: 1, method: "fs/readFile", params: { path: registry } },
        attachmentRoot,
      ),
    ).toBe("registry");
    expect(
      allowedLocalAttachmentRequest(
        {
          id: 2,
          method: "fs/createDirectory",
          params: { path: directory, recursive: true },
        },
        attachmentRoot,
      ),
    ).toBe("attachment-directory");
    expect(
      allowedLocalAttachmentRequest(
        {
          id: 3,
          method: "fs/writeFile",
          params: { path: pastedText, dataBase64: "dGVzdA==" },
        },
        attachmentRoot,
      ),
    ).toBe("pasted-text");
    expect(
      allowedLocalAttachmentRequest(
        {
          id: 4,
          method: "fs/writeFile",
          params: { path: registry, dataBase64: "e30=" },
        },
        attachmentRoot,
      ),
    ).toBe("registry");
    expect(
      allowedLocalAttachmentRequest(
        {
          id: 5,
          method: "fs/readFile",
          params: { path: pastedText },
        },
        attachmentRoot,
      ),
    ).toBe("pasted-text");
    expect(
      allowedLocalAttachmentRequest(
        {
          id: 6,
          method: "fs/remove",
          params: { path: pastedText, force: true },
        },
        attachmentRoot,
      ),
    ).toBe("pasted-text");
  });

  it("keeps malformed, root-external, and unrelated attachment requests blocked", () => {
    const validDirectory = join(attachmentRoot, attachmentId);
    for (const message of [
      {
        id: 1,
        method: "fs/writeFile",
        params: {
          path: resolve(attachmentRoot, "..", "..", "project", "source.ts"),
          dataBase64: "dGVzdA==",
        },
      },
      {
        id: 2,
        method: "fs/writeFile",
        params: {
          path: join(attachmentRoot, "not-a-uuid", "pasted-text.txt"),
          dataBase64: "dGVzdA==",
        },
      },
      {
        id: 3,
        method: "fs/writeFile",
        params: {
          path: join(validDirectory, "other.txt"),
          dataBase64: "dGVzdA==",
        },
      },
      {
        id: 4,
        method: "fs/createDirectory",
        params: { path: validDirectory, recursive: false },
      },
      {
        id: 5,
        method: "fs/remove",
        params: {
          path: join(validDirectory, "pasted-text.txt"),
          force: true,
          recursive: true,
        },
      },
      {
        id: 6,
        method: "fs/writeFile",
        params: {
          path: join(validDirectory, "pasted-text.txt"),
          dataBase64: "A".repeat(14 * 1024 * 1024),
        },
      },
      {
        id: 7,
        method: "fs/copy",
        params: {
          path: join(validDirectory, "pasted-text.txt"),
          sourcePath: "/tmp/source",
        },
      },
      {
        id: 8,
        method: "fs/futureMutation",
        params: { path: join(validDirectory, "pasted-text.txt") },
      },
      {
        method: "fs/readFile",
        params: { path: join(validDirectory, "pasted-text.txt") },
      },
    ]) {
      expect(allowedLocalAttachmentRequest(message, attachmentRoot)).toBeNull();
    }
  });
});
