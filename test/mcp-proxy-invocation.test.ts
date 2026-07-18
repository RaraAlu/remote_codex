import { describe, expect, it } from "vitest";
import { parseMcpProxyInvocation } from "../src/shim/mcp-proxy-invocation.js";

describe("parseMcpProxyInvocation", () => {
  it("uses an explicit session file when Codex strips Bridge environment variables", () => {
    const configPath =
      process.platform === "win32"
        ? "C:\\bridge\\sessions\\123.json"
        : "/home/user/.local/state/codex-remote-bridge/sessions/123.json";

    expect(
      parseMcpProxyInvocation([
        "mcp-proxy",
        "--session-config",
        configPath,
        "index-mcp",
        "serve",
      ]),
    ).toEqual({
      args: ["serve"],
      configPath,
      executable: "index-mcp",
    });
  });

  it("retains the environment-based form for existing launchers", () => {
    expect(parseMcpProxyInvocation(["mcp-proxy", "index-mcp", "serve"])).toEqual({
      args: ["serve"],
      configPath: null,
      executable: "index-mcp",
    });
  });

  it("rejects a relative explicit session path", () => {
    expect(() =>
      parseMcpProxyInvocation([
        "mcp-proxy",
        "--session-config",
        "sessions/123.json",
        "index-mcp",
      ]),
    ).toThrow(/session arguments are invalid/);
  });
});
