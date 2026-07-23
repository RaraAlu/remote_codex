import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { REMOTE_TOOL_NAMES } from "../src/shim/dynamic-tools.js";
import { REMOTE_PERMISSION_PROFILE_ID } from "../src/shim/local-core-policy.js";
import { isUnknownServerRequest } from "../src/shim/proxy.js";
import { rewriteClientMessage } from "../src/shim/rewrite.js";

const config = parseBridgeConfig({
  host: "training-gpu",
  workspaceRoot: "/home/zkbot/work/train/MimicLite",
});

describe("app-server request rewriting", () => {
  it("opts into the generated experimental protocol without dropping capabilities", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 1,
        method: "initialize",
        params: { capabilities: { requestAttestation: true } },
      },
      config,
      "/local/control",
    );
    expect(rewritten).toMatchObject({
      params: {
        capabilities: {
          requestAttestation: true,
          experimentalApi: true,
        },
      },
    });
  });

  it("keeps the process cwd local while assigning the remote primary root to the thread", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 2,
        method: "thread/start",
        params: {
          cwd: "/home/zkbot/work/train/MimicLite",
          config: { sandbox_mode: "danger-full-access" },
          permissions: "full-access",
          sandbox: "danger-full-access",
          dynamicTools: [{ type: "function", name: "existing", description: "", inputSchema: {} }],
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };
    expect(rewritten.params.cwd).toBe("/local/control");
    expect(rewritten.params.runtimeWorkspaceRoots).toEqual([
      "/home/zkbot/work/train/MimicLite",
    ]);
    expect(rewritten.params.permissions).toBe(REMOTE_PERMISSION_PROFILE_ID);
    expect(rewritten.params.approvalPolicy).toBe("never");
    expect(rewritten.params).not.toHaveProperty("config");
    expect(rewritten.params).not.toHaveProperty("sandbox");
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Never fall back to local execution",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Local MCP, app, and connector tools may be used",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Root id: remote-primary",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "remote_exec is the project command runner",
    );
    const tools = rewritten.params.dynamicTools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "existing",
      ...REMOTE_TOOL_NAMES,
    ]);
  });

  it("forces the local-deny permission profile when resuming", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 3,
        method: "thread/resume",
        params: {
          threadId: "thread_123",
          approvalPolicy: "on-request",
          config: { sandbox_mode: "danger-full-access" },
          permissions: "full-access",
          sandbox: "danger-full-access",
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };

    expect(rewritten.params).toMatchObject({
      cwd: "/local/control",
      runtimeWorkspaceRoots: ["/home/zkbot/work/train/MimicLite"],
      permissions: REMOTE_PERMISSION_PROFILE_ID,
      approvalPolicy: "never",
    });
    expect(rewritten.params).not.toHaveProperty("config");
    expect(rewritten.params).not.toHaveProperty("sandbox");
  });

  it("refreshes the remote primary root and remote_exec policy on every turn", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 4,
        method: "turn/start",
        params: {
          threadId: "thread_123",
          input: [{ type: "text", text: "run tests" }],
          cwd: "/home/zkbot/work/train/MimicLite",
          permissions: "full-access",
          sandboxPolicy: { type: "dangerFullAccess" },
          additionalContext: {
            official: {
              kind: "application",
              value: "keep me",
            },
            "codex-remote-bridge": {
              kind: "application",
              value: "stale",
            },
          },
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };

    expect(rewritten.params).toMatchObject({
      approvalPolicy: "never",
      cwd: "/local/control",
      permissions: REMOTE_PERMISSION_PROFILE_ID,
      runtimeWorkspaceRoots: ["/home/zkbot/work/train/MimicLite"],
      additionalContext: {
        official: {
          kind: "application",
          value: "keep me",
        },
        "codex-remote-bridge": {
          kind: "application",
        },
      },
    });
    const additionalContext = rewritten.params.additionalContext as Record<
      string,
      { kind: string; value: string }
    >;
    const bridgeContext = additionalContext["codex-remote-bridge"]!;
    expect(bridgeContext.value).toContain("Role: primary");
    expect(bridgeContext.value).toContain(
      "Use remote_exec for all project commands",
    );
    expect(bridgeContext.value).not.toContain("stale");
    expect(rewritten.params).not.toHaveProperty("sandboxPolicy");
  });

  it("prevents settings updates and forks from relaxing the local-deny policy", () => {
    const settings = rewriteClientMessage(
      {
        id: 5,
        method: "thread/settings/update",
        params: {
          threadId: "thread_123",
          cwd: "/local/project",
          permissions: "full-access",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };
    expect(settings.params).toMatchObject({
      threadId: "thread_123",
      cwd: "/local/control",
      approvalPolicy: "never",
      permissions: REMOTE_PERMISSION_PROFILE_ID,
    });
    expect(settings.params).not.toHaveProperty("sandboxPolicy");

    const fork = rewriteClientMessage(
      {
        id: 6,
        method: "thread/fork",
        params: {
          threadId: "thread_123",
          cwd: "/local/project",
          config: { sandbox_mode: "danger-full-access" },
          permissions: "full-access",
          sandbox: "danger-full-access",
          developerInstructions: "keep me",
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };
    expect(fork.params).toMatchObject({
      threadId: "thread_123",
      cwd: "/local/control",
      approvalPolicy: "never",
      permissions: REMOTE_PERMISSION_PROFILE_ID,
      runtimeWorkspaceRoots: ["/home/zkbot/work/train/MimicLite"],
    });
    expect(String(fork.params.developerInstructions)).toContain("keep me");
    expect(String(fork.params.developerInstructions)).toContain(
      "Never fall back to local execution",
    );
    expect(fork.params).not.toHaveProperty("config");
    expect(fork.params).not.toHaveProperty("sandbox");
  });

  it("fails closed for unknown server requests", () => {
    expect(
      isUnknownServerRequest({ id: 1, method: "future/sideEffect", params: {} }),
    ).toBe(true);
    expect(
      isUnknownServerRequest({ id: 2, method: "item/tool/requestUserInput", params: {} }),
    ).toBe(false);
  });
});
