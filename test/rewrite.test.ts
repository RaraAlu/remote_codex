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
          dynamicTools: [{ type: "function", name: "existing", description: "", inputSchema: {} }],
        },
      },
      config,
      "/local/control",
    ) as { params: Record<string, unknown> };
    expect(rewritten.params.cwd).toBe("/local/control");
    expect(rewritten.params.runtimeWorkspaceRoots).toEqual(["/local/control"]);
    expect(rewritten.params.sandbox).toBe("read-only");
    expect(String(rewritten.params.developerInstructions)).toContain(
      "Never fall back to local execution",
    );
    const tools = rewritten.params.dynamicTools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "existing",
      ...REMOTE_TOOL_NAMES,
    ]);
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
