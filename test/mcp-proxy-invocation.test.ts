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
      adapterId: null,
      args: ["serve"],
      configPath,
      executable: "index-mcp",
      serverName: null,
    });
  });

  it("retains the environment-based form for existing launchers", () => {
    expect(parseMcpProxyInvocation(["mcp-proxy", "index-mcp", "serve"])).toEqual({
      adapterId: null,
      args: ["serve"],
      configPath: null,
      executable: "index-mcp",
      serverName: null,
    });
  });

  it("parses a generic registered adapter without carrying environment values", () => {
    expect(
      parseMcpProxyInvocation([
        "mcp-proxy",
        "--server-name",
        "codegraph",
        "--adapter",
        "codegraph-all-tools-v1",
        "codegraph",
        "serve",
      ]),
    ).toEqual({
      adapterId: "codegraph-all-tools-v1",
      args: ["serve"],
      configPath: null,
      executable: "codegraph",
      serverName: "codegraph",
    });
  });

  it("requires a server name before an adapter", () => {
    expect(() =>
      parseMcpProxyInvocation([
        "mcp-proxy",
        "--adapter",
        "codegraph-all-tools-v1",
        "codegraph",
      ]),
    ).toThrow(/adapter is invalid/);
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
