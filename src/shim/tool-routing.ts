import type { BridgeConfig } from "../core/types.js";
import {
  REMOTE_BACKGROUND_TOOL_NAMES,
  REMOTE_DYNAMIC_TOOLS,
  WORKSPACE_MUTATION_TOOL_NAMES,
  WORKSPACE_RESOURCE_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from "./dynamic-tools.js";

export type ToolExecutionLocation =
  | "local"
  | "provider-defined"
  | "remote"
  | "selected-root"
  | "unavailable";

export type ToolRouteStatus =
  | "available"
  | "degraded"
  | "provider-managed"
  | "route-configured"
  | "unavailable";

export interface ToolRouteDescriptor {
  capabilities: string[];
  detail: string;
  location: ToolExecutionLocation;
  provider: "app" | "bridge-dynamic" | "connector" | "mcp" | "web";
  selector: string;
  status: ToolRouteStatus;
  workspaceBinding: "explicit-root" | "none" | "provider-defined" | "remote-primary";
}

export interface ToolRouteInventory {
  primaryRootId: string;
  routes: ToolRouteDescriptor[];
  schemaVersion: 1;
}

export interface ToolRouteObservation {
  localMcpServers?: readonly string[];
  mcpRoutingFailed?: boolean;
  remoteMcpServers?: readonly string[];
  skippedMcpAccessServers?: readonly string[];
}

function dynamicToolCapabilities(name: string): string[] {
  if (WORKSPACE_MUTATION_TOOL_NAMES.has(name)) {
    return ["workspace", "mutation"];
  }
  if (WORKSPACE_RESOURCE_TOOL_NAMES.has(name)) {
    return ["workspace", "editor"];
  }
  if (name === "workspace_git_status") {
    return ["workspace", "git-read"];
  }
  if (WORKSPACE_TOOL_NAMES.has(name)) {
    return ["workspace", "read"];
  }
  if (REMOTE_BACKGROUND_TOOL_NAMES.has(name)) {
    return ["command", "background"];
  }
  return ["command", "foreground"];
}

function dynamicToolRoutes(): ToolRouteDescriptor[] {
  return REMOTE_DYNAMIC_TOOLS.map((tool) => {
    const selectedRoot = WORKSPACE_TOOL_NAMES.has(tool.name);
    return {
      capabilities: dynamicToolCapabilities(tool.name),
      detail: selectedRoot
        ? "Bridge validates an explicit authorized root; omission selects the remote primary root."
        : "Bridge executes through the active Remote SSH transport in the remote primary root.",
      location: selectedRoot ? "selected-root" : "remote",
      provider: "bridge-dynamic",
      selector: tool.name,
      status: "available",
      workspaceBinding: selectedRoot ? "explicit-root" : "remote-primary",
    };
  });
}

function mcpRoutes(observation: ToolRouteObservation): ToolRouteDescriptor[] {
  const remote = new Set(observation.remoteMcpServers ?? []);
  const local = new Set(observation.localMcpServers ?? []);
  const skipped = new Set(observation.skippedMcpAccessServers ?? []);
  const names = [...new Set([...remote, ...local, ...skipped])].sort();
  const routes = names.map<ToolRouteDescriptor>((name) => {
    const remoteRouted = remote.has(name);
    const accessSkipped = skipped.has(name);
    return {
      capabilities: ["provider-tools"],
      detail: accessSkipped
        ? "The active app-server rejected the requested access override; existing provider availability is retained without a Bridge access claim."
        : remoteRouted
          ? "The remote executable probe and app-server route override succeeded; this does not declare that any individual provider tool is present in the current turn."
          : "The configured provider transport remains local; Bridge does not grant it remote workspace semantics or declare individual provider-tool availability.",
      location: remoteRouted ? "remote" : "local",
      provider: "mcp",
      selector: `mcp:${name}/*`,
      status: accessSkipped ? "degraded" : "route-configured",
      workspaceBinding: remoteRouted ? "remote-primary" : "none",
    };
  });
  if (observation.mcpRoutingFailed) {
    routes.push({
      capabilities: ["provider-tools"],
      detail: "MCP route discovery failed; inspect the Bridge audit log for the runtime failure.",
      location: "unavailable",
      provider: "mcp",
      selector: "mcp:*",
      status: "unavailable",
      workspaceBinding: "none",
    });
  }
  return routes;
}

function passthroughRoutes(): ToolRouteDescriptor[] {
  const detail =
    "The official app-server owns discovery and execution. Bridge preserves the provider location and does not infer workspace access.";
  return [
    {
      capabilities: ["provider-defined"],
      detail,
      location: "provider-defined",
      provider: "app",
      selector: "app:*",
      status: "provider-managed",
      workspaceBinding: "provider-defined",
    },
    {
      capabilities: ["provider-defined"],
      detail,
      location: "provider-defined",
      provider: "connector",
      selector: "connector:*",
      status: "provider-managed",
      workspaceBinding: "provider-defined",
    },
    {
      capabilities: ["web"],
      detail,
      location: "provider-defined",
      provider: "web",
      selector: "web:*",
      status: "provider-managed",
      workspaceBinding: "none",
    },
  ];
}

export function createToolRouteInventory(
  config: BridgeConfig,
  observation: ToolRouteObservation = {},
): ToolRouteInventory {
  const primaryRoot = config.roots.find(
    (root) => root.target === "remote" && root.role === "primary",
  );
  if (!primaryRoot) {
    throw new TypeError("Bridge configuration has no remote primary root");
  }
  return {
    primaryRootId: primaryRoot.id,
    routes: [...dynamicToolRoutes(), ...mcpRoutes(observation), ...passthroughRoutes()].sort(
      (left, right) =>
        left.selector === right.selector ? 0 : left.selector < right.selector ? -1 : 1,
    ),
    schemaVersion: 1,
  };
}

export function formatToolRouteInventory(inventory: ToolRouteInventory): string {
  return [
    "Unified tool route inventory:",
    "- Treat this inventory as authoritative for execution location and workspace binding.",
    "- Family selectors with status=route-configured describe provider routing only; call an individual provider tool only when it is present in the current turn's tool list.",
    "- Never infer a tool's execution location from the presence or absence of target or rootId parameters.",
    "- target and rootId select roots only for routes whose workspaceBinding is explicit-root.",
    `- Remote primary root id: ${inventory.primaryRootId}.`,
    ...inventory.routes.map(
      (route) =>
        `- ${route.selector}: provider=${route.provider}; location=${route.location}; workspaceBinding=${route.workspaceBinding}; status=${route.status}; capabilities=${route.capabilities.join(",")}; ${route.detail}`,
    ),
  ].join("\n");
}

export function serializeToolRouteInventory(inventory: ToolRouteInventory): string {
  return JSON.stringify(inventory);
}
