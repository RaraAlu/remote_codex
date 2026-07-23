import { describe, expect, it } from "vitest";
import {
  resolveRemoteMcpLaunch,
  selectRemoteMcpAdapter,
} from "../src/core/remote-mcp-adapters.js";

describe("remote MCP adapters", () => {
  it("selects the CodeGraph capability adapter only for all-access routing", () => {
    expect(
      selectRemoteMcpAdapter({
        access: "all",
        executable: "codegraph",
        serverName: "codegraph",
      }),
    ).toBe("codegraph-all-tools-v1");
    expect(
      selectRemoteMcpAdapter({
        access: "enabled",
        executable: "codegraph",
        serverName: "codegraph",
      }),
    ).toBeNull();
    expect(
      selectRemoteMcpAdapter({
        access: "all",
        executable: "other-mcp",
        serverName: "other",
      }),
    ).toBeNull();
  });

  it("resolves a registered adapter to reviewed launch changes", () => {
    expect(
      resolveRemoteMcpLaunch({
        adapterId: "codegraph-all-tools-v1",
        args: ["serve", "--mcp", "--path", "/workspace"],
        executable: "codegraph",
        serverName: "codegraph",
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      args: ["serve", "--mcp", "--path", "/workspace"],
      environment: {
        CODEGRAPH_MCP_TOOLS: "search,callers,callees,impact,node,explore,status,files",
      },
    });
  });

  it("fails closed for unknown or mismatched adapters", () => {
    const base = {
      args: ["serve", "--mcp", "--path", "/workspace"],
      executable: "codegraph",
      serverName: "codegraph",
      workspaceRoot: "/workspace",
    };
    expect(() =>
      resolveRemoteMcpLaunch({ ...base, adapterId: "unknown-adapter" }),
    ).toThrow(/not registered/);
    expect(() =>
      resolveRemoteMcpLaunch({
        ...base,
        adapterId: "codegraph-all-tools-v1",
        executable: "other-mcp",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      resolveRemoteMcpLaunch({
        ...base,
        adapterId: "codegraph-all-tools-v1",
        args: ["serve", "--mcp", "--path", "/other"],
      }),
    ).toThrow(/does not match/);
  });
});
