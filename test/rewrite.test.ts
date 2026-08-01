import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { REMOTE_DYNAMIC_TOOLS } from "../src/shim/dynamic-tools.js";
import { REMOTE_PERMISSION_PROFILE_ID } from "../src/shim/local-core-policy.js";
import { isUnknownServerRequest } from "../src/shim/proxy.js";
import { createToolRouteInventory } from "../src/shim/tool-routing.js";
import {
  rewriteClientMessage,
  scopeThreadListToWorkspace,
} from "../src/shim/rewrite.js";

const config = parseBridgeConfig({
  version: 2,
  host: "training-gpu",
  roots: [
    {
      id: "remote-primary",
      target: "remote",
      role: "primary",
      path: "/home/zkbot/work/train/MimicLite",
      displayName: "MimicLite",
    },
    {
      id: "local-reference",
      target: "local",
      role: "secondary",
      path: "/home/zkbot/reference",
      displayName: "Reference",
    },
  ],
});
const remoteCodegraphRoutes = createToolRouteInventory(config, {
  remoteMcpServers: ["codegraph"],
});

describe("app-server request rewriting", () => {
  it("scopes the official local task list to the open workspace", () => {
    const message = {
      id: 0,
      method: "thread/list",
      params: {
        archived: false,
        cwd: null,
        limit: 50,
        sortKey: "updated_at",
      },
    };

    expect(
      scopeThreadListToWorkspace(
        message,
        "/home/zkbot/work/train/MimicLite",
      ),
    ).toEqual({
      ...message,
      params: {
        ...message.params,
        cwd: "/home/zkbot/work/train/MimicLite",
      },
    });
    expect(scopeThreadListToWorkspace(message, undefined)).toBe(message);
  });

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
      null,
      remoteCodegraphRoutes,
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
      "Never fall back to unapproved local execution",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Local MCP, app, connector, and web tools may be used",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "mcp:codegraph/*: provider=mcp; location=remote",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Never infer a tool's execution location from the presence or absence of target or rootId",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "When a Codegraph MCP tool is present in the current turn's tool list",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Root id: remote-primary",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Root id: local-reference; target: local; role: secondary",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "remote_exec is the project command runner",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "use remote_background_start once",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Use workspace_open_file for editor jumps",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "workspace-relative Markdown targets",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "use workspace_show_diff",
    );
    const tools = rewritten.params.dynamicTools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "existing",
      ...REMOTE_DYNAMIC_TOOLS.map((tool) => tool.name),
    ]);
  });

  it("uses a native Windows control root without losing the remote project policy", () => {
    const controlDir = String.raw`C:\Users\zkbot\AppData\Local\bridge\control`;
    for (const method of [
      "thread/start",
      "thread/resume",
      "turn/start",
      "thread/fork",
    ] as const) {
      const rewritten = rewriteClientMessage(
        {
          id: method,
          method,
          params: { threadId: "thread_123" },
        },
        config,
        controlDir,
      ) as { params: Record<string, unknown> };
      const turnContext = (
        rewritten.params.additionalContext as
          | Record<string, { value?: unknown }>
          | undefined
      )?.["codex-remote-bridge"]?.value;
      const policy = rewritten.params.developerInstructions ?? turnContext;

      expect(rewritten.params.cwd).toBe(controlDir);
      expect(rewritten.params.runtimeWorkspaceRoots).toEqual([controlDir]);
      expect(String(policy)).toContain("/home/zkbot/work/train/MimicLite");
    }
  });

  it("maps an external full-access sandbox request to the remote permission profile", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 3,
        method: "thread/start",
        params: {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
      config,
      "/local/control",
      null,
    ) as { params: Record<string, unknown> };

    expect(rewritten.params.permissions).toBe(REMOTE_PERMISSION_PROFILE_ID);
    expect(rewritten.params.approvalPolicy).toBe("never");
    expect(rewritten.params).not.toHaveProperty("sandbox");
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
            "codex-remote-bridge-editor-context": {
              kind: "application",
              value: "stale editor content",
            },
            "codex-remote-bridge-tool-routes": {
              kind: "application",
              value: "stale routes",
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
    expect(bridgeContext.value).toContain("role: primary");
    expect(bridgeContext.value).toContain(
      "Use remote_exec for all project commands",
    );
    expect(bridgeContext.value).not.toContain("mcp:codegraph/*");
    expect(bridgeContext.value).toContain(
      "first use remote_exec to probe codegraph --version",
    );
    expect(bridgeContext.value).not.toContain("stale");
    expect(additionalContext).not.toHaveProperty(
      "codex-remote-bridge-editor-context",
    );
    const toolRoutes = JSON.parse(
      additionalContext["codex-remote-bridge-tool-routes"]!.value,
    ) as { primaryRootId: string; schemaVersion: number };
    expect(toolRoutes).toMatchObject({
      primaryRootId: "remote-primary",
      schemaVersion: 1,
    });
    expect(rewritten.params).not.toHaveProperty("sandboxPolicy");
  });

  it("injects one explicit Remote SSH editor selection without replacing official context", () => {
    const content = "REMOTE_SELECTION_LINE_L03_0331";
    const rewritten = rewriteClientMessage(
      {
        id: 41,
        method: "turn/start",
        params: {
          threadId: "thread_123",
          input: [{ type: "text", text: "inspect selection" }],
          additionalContext: {
            official: {
              kind: "application",
              value: "keep me",
            },
          },
        },
      },
      config,
      "/local/control",
      {
        capturedAtMs: 1,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        contextId: "context-1",
        hostId: "training-gpu",
        kind: "selection",
        languageId: "plaintext",
        origin: "explicit",
        relativePath: "current-editor.txt",
        resourceUri:
          "codex-bridge://workspace/remote-primary/current-editor.txt?host=training-gpu&target=remote",
        rootId: "remote-primary",
        selection: {
          start: { column: 1, line: 2 },
          end: { column: 31, line: 2 },
        },
        sizeBytes: Buffer.byteLength(content),
        target: "remote",
        workspaceRoot: "/home/zkbot/work/train/MimicLite",
        workspaceUri:
          "vscode-remote://ssh-remote%2Btraining-gpu/home/zkbot/work/train/MimicLite/current-editor.txt",
      },
    ) as { params: Record<string, unknown> };

    const additionalContext = rewritten.params.additionalContext as Record<
      string,
      { kind: string; value: string }
    >;
    expect(additionalContext.official?.value).toBe("keep me");
    const editorContext =
      additionalContext["codex-remote-bridge-editor-context"]!;
    expect(editorContext.kind).toBe("application");
    expect(editorContext.value).toContain("Relative path: current-editor.txt");
    expect(editorContext.value).toContain(
      "Workspace URI: vscode-remote://ssh-remote%2Btraining-gpu/",
    );
    expect(editorContext.value).toContain("Selection start: line 2, column 1");
    expect(editorContext.value).toContain(JSON.stringify(content));
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
      "Never fall back to unapproved local execution",
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
