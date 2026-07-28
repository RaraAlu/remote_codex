import { describe, expect, it } from "vitest";
import { RemoteApprovalPolicyTracker } from "../src/shim/remote-approval-policy.js";

describe("remote approval policy tracking", () => {
  it("maps a full-access thread to automatic remote command approval", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 1,
      method: "thread/start",
      params: { permissions: "full-access" },
    });
    tracker.observeServerMessage({
      id: 1,
      result: { thread: { id: "thread-full" } },
    });

    expect(tracker.modeForThread("thread-full")).toBe("never");
    expect(tracker.requiresApproval("thread-full")).toBe(false);
  });

  it("honors approvalPolicy never and later turn overrides", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 2,
      method: "thread/start",
      params: { approvalPolicy: "never" },
    });
    tracker.observeServerMessage({
      id: 2,
      result: { thread: { id: "thread-policy" } },
    });
    expect(tracker.requiresApproval("thread-policy")).toBe(false);

    tracker.observeClientMessage({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-policy",
        approvalPolicy: "on-request",
        input: [],
      },
    });
    expect(tracker.requiresApproval("thread-policy")).toBe(true);
  });

  it("fails closed for resumed and unknown threads without an explicit mode", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 4,
      method: "thread/resume",
      params: { threadId: "thread-resumed" },
    });

    expect(tracker.requiresApproval("thread-resumed")).toBe(true);
    expect(tracker.requiresApproval("thread-unknown")).toBe(true);
  });

  it("projects the internal local policy back to the requested official UI modes", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 5,
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    const fullAccessResponse = {
      id: 5,
      result: {
        thread: { id: "thread-visible" },
        approvalPolicy: "never",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: {
          id: "codex-remote-bridge",
          extends: null,
        },
      },
    };
    tracker.observeServerMessage(fullAccessResponse);

    expect(tracker.projectServerMessage(fullAccessResponse)).toMatchObject({
      result: {
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
        activePermissionProfile: {
          id: ":danger-full-access",
          extends: null,
        },
      },
    });

    tracker.observeClientMessage({
      id: 6,
      method: "thread/settings/update",
      params: {
        threadId: "thread-visible",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/local/project"],
          networkAccess: true,
        },
      },
    });
    const settingsNotification = {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-visible",
        threadSettings: {
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: {
            id: "codex-remote-bridge",
            extends: null,
          },
        },
      },
    };

    expect(tracker.requiresApproval("thread-visible")).toBe(true);
    expect(tracker.projectServerMessage(settingsNotification)).toMatchObject({
      params: {
        threadSettings: {
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
          },
          activePermissionProfile: {
            id: ":workspace",
            extends: null,
          },
        },
      },
    });
  });

  it("does not alter permission state that was not produced by the Bridge profile", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    const response = {
      id: 7,
      result: {
        thread: { id: "thread-native" },
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
        activePermissionProfile: null,
      },
    };

    expect(tracker.projectServerMessage(response)).toBe(response);
  });

  it("hides only the internal default profile from official config reads", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    const response = {
      id: 8,
      result: {
        config: {
          approval_policy: "never",
          sandbox_mode: "danger-full-access",
          default_permissions: "codex-remote-bridge",
          permissions: {
            "codex-remote-bridge": {
              filesystem: { ":root": "deny" },
            },
            "user-profile": {
              filesystem: { "/tmp": "read" },
            },
          },
        },
        origins: {
          "permissions.codex-remote-bridge.description": {
            name: { type: "sessionFlags" },
          },
          "permissions.codex-remote-bridge.network.enabled": {
            name: { type: "sessionFlags" },
          },
          default_permissions: { name: { type: "sessionFlags" } },
          permissions: {
            "codex-remote-bridge": {
              filesystem: {
                ":root": { name: { type: "sessionFlags" } },
              },
            },
            "user-profile": {
              filesystem: {
                "/tmp": { name: { type: "user" } },
              },
            },
          },
        },
        layers: [
          {
            name: { type: "sessionFlags" },
            config: {
              default_permissions: "codex-remote-bridge",
              permissions: {
                "codex-remote-bridge": {
                  filesystem: { ":root": "deny" },
                },
              },
              mcp_servers: { codegraph: { enabled: true } },
            },
          },
        ],
      },
    };

    expect(tracker.projectServerMessage(response)).toEqual({
      id: 8,
      result: {
        config: {
          approval_policy: "never",
          sandbox_mode: "danger-full-access",
          default_permissions: null,
          permissions: {
            "user-profile": {
              filesystem: { "/tmp": "read" },
            },
          },
        },
        origins: {
          permissions: {
            "user-profile": {
              filesystem: {
                "/tmp": { name: { type: "user" } },
              },
            },
          },
        },
        layers: [
          {
            name: { type: "sessionFlags" },
            config: {
              mcp_servers: { codegraph: { enabled: true } },
            },
          },
        ],
      },
    });
  });

  it("filters the internal profile only from permission profile list responses", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 9,
      method: "permissionProfile/list",
      params: { cwd: null },
    });
    const response = {
      id: 9,
      result: {
        data: [
          { id: ":read-only", description: null, allowed: true },
          { id: ":workspace", description: null, allowed: true },
          { id: ":danger-full-access", description: null, allowed: true },
          {
            id: "codex-remote-bridge",
            description: "Codex Remote Bridge local-deny policy",
            allowed: true,
          },
          { id: "user-profile", description: "User profile", allowed: true },
        ],
        nextCursor: null,
      },
    };
    tracker.observeServerMessage(response);

    expect(tracker.projectServerMessage(response)).toEqual({
      id: 9,
      result: {
        data: [
          { id: ":read-only", description: null, allowed: true },
          { id: ":workspace", description: null, allowed: true },
          { id: ":danger-full-access", description: null, allowed: true },
          { id: "user-profile", description: "User profile", allowed: true },
        ],
        nextCursor: null,
      },
    });

    const unrelatedResponse = { ...response, id: 10 };
    expect(tracker.projectServerMessage(unrelatedResponse)).toBe(
      unrelatedResponse,
    );
  });
});
