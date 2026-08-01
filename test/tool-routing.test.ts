import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { REMOTE_DYNAMIC_TOOLS } from "../src/shim/dynamic-tools.js";
import {
  createToolRouteInventory,
  formatToolRouteInventory,
  serializeToolRouteInventory,
} from "../src/shim/tool-routing.js";

const config = parseBridgeConfig({
  host: "training-gpu",
  workspaceRoot: "/remote/workspace",
});

describe("unified tool route inventory", () => {
  it("describes every Bridge dynamic tool and the observed provider routes", () => {
    const inventory = createToolRouteInventory(config, {
      localMcpServers: ["github", "disabled"],
      remoteMcpServers: ["codegraph"],
      skippedMcpAccessServers: ["disabled"],
    });
    const bySelector = new Map(inventory.routes.map((route) => [route.selector, route]));

    expect(inventory).toMatchObject({
      primaryRootId: "remote-primary",
      schemaVersion: 1,
    });
    expect(
      REMOTE_DYNAMIC_TOOLS.every((tool) => bySelector.has(tool.name)),
    ).toBe(true);
    expect(bySelector.get("workspace_read_file")).toMatchObject({
      location: "selected-root",
      provider: "bridge-dynamic",
      status: "available",
      workspaceBinding: "explicit-root",
    });
    expect(bySelector.get("remote_exec")).toMatchObject({
      location: "remote",
      workspaceBinding: "remote-primary",
    });
    expect(bySelector.get("mcp:codegraph/*")).toMatchObject({
      location: "remote",
      status: "route-configured",
      workspaceBinding: "remote-primary",
    });
    expect(bySelector.get("mcp:github/*")).toMatchObject({
      location: "local",
      status: "route-configured",
      workspaceBinding: "none",
    });
    expect(bySelector.get("mcp:disabled/*")).toMatchObject({
      location: "local",
      status: "degraded",
    });
    expect(bySelector.get("app:*")).toMatchObject({
      location: "provider-defined",
      status: "provider-managed",
      workspaceBinding: "provider-defined",
    });
    expect(bySelector.get("connector:*")).toBeDefined();
    expect(bySelector.get("web:*")).toBeDefined();
    expect(inventory.routes.map((route) => route.selector)).toEqual(
      [...inventory.routes.map((route) => route.selector)].sort((left, right) =>
        left === right ? 0 : left < right ? -1 : 1,
      ),
    );
  });

  it("reports discovery failure without serializing process configuration", () => {
    const inventory = createToolRouteInventory(config, { mcpRoutingFailed: true });
    expect(inventory.routes.find((route) => route.selector === "mcp:*")).toMatchObject({
      location: "unavailable",
      status: "unavailable",
    });

    const serialized = serializeToolRouteInventory(inventory);
    expect(serialized).not.toContain('"args"');
    expect(serialized).not.toContain('"cwd"');
    expect(serialized).not.toContain('"env"');
    expect(serialized).not.toContain('"path"');
  });

  it("makes routing authoritative instead of using parameter-shape inference", () => {
    const formatted = formatToolRouteInventory(
      createToolRouteInventory(config, { remoteMcpServers: ["codegraph"] }),
    );
    expect(formatted).toContain("Treat this inventory as authoritative");
    expect(formatted).toContain(
      "Never infer a tool's execution location from the presence or absence of target or rootId",
    );
    expect(formatted).toContain(
      "status=route-configured describe provider routing only",
    );
    expect(formatted).toContain(
      "mcp:codegraph/*: provider=mcp; location=remote; workspaceBinding=remote-primary",
    );
  });
});
