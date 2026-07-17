import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { REMOTE_TOOL_NAMES } from "../src/shim/dynamic-tools.js";
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

  it("pins thread cwd locally and injects only remote project tools", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 2,
        method: "thread/start",
        params: {
          cwd: "/home/zkbot/work/train/MimicLite",
          permissions: "full-access",
          dynamicTools: [{ type: "function", name: "existing", description: "", inputSchema: {} }],
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };
    expect(rewritten.params.cwd).toBe("/local/control");
    expect(rewritten.params.runtimeWorkspaceRoots).toEqual(["/local/control"]);
    expect(rewritten.params.sandbox).toBe("read-only");
    expect(rewritten.params).not.toHaveProperty("permissions");
    expect(rewritten.params.approvalPolicy).toBe("never");
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Never fall back to local execution",
    );
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Local MCP, app, and connector tools may be used",
    );
    const tools = rewritten.params.dynamicTools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "existing",
      ...REMOTE_TOOL_NAMES,
    ]);
  });

  it("removes the named permission profile when resuming under the read-only sandbox", () => {
    const rewritten = rewriteClientMessage(
      {
        id: 3,
        method: "thread/resume",
        params: {
          threadId: "thread_123",
          permissions: "full-access",
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };

    expect(rewritten.params).toMatchObject({
      cwd: "/local/control",
      runtimeWorkspaceRoots: ["/local/control"],
      sandbox: "read-only",
    });
    expect(rewritten.params).not.toHaveProperty("permissions");
    expect(rewritten.params.approvalPolicy).toBe("never");
  });

  it("keeps turn-level full access for approvals while forcing local read-only safety", () => {
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
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };

    expect(rewritten.params).toMatchObject({
      approvalPolicy: "never",
      cwd: "/local/control",
      runtimeWorkspaceRoots: ["/local/control"],
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    });
    expect(rewritten.params).not.toHaveProperty("permissions");
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
