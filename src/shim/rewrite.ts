import type { BridgeConfig, WorkspaceRootConfig } from "../core/types.js";
import { REMOTE_DYNAMIC_TOOLS, REMOTE_TOOL_NAMES } from "./dynamic-tools.js";
import { isRecord, type RpcMessage } from "./rpc.js";

const REMOTE_INSTRUCTIONS = `Codex Remote Bridge execution policy:
- The project exists only on the configured remote Ubuntu host.
- Use remote_* dynamic tools for project files, search, Git, tests, and commands.
- For project overviews, prefer one remote_list_tree call before focused directory listings.
- At the start of every turn, remember that remote_exec is the project command runner.
- Use remote_exec for all project commands. Its approval behavior follows the active Codex permission mode.
- Local MCP, app, and connector tools may be used for complementary capabilities.
- A local MCP tool must not read, write, or execute project paths unless it explicitly supports the configured remote target.
- Never use local shell or local filesystem tools for project operations.
- The local cwd is an empty control directory and is not the project.
- When a required remote capability is unavailable, stop and report that the bridge does not support it. Never fall back to local execution.`;

const REMOTE_TURN_CONTEXT_KEY = "codex-remote-bridge";

function remotePrimaryRoot(config: BridgeConfig): WorkspaceRootConfig {
  const root = config.roots.find(
    (root) => root.target === "remote" && root.role === "primary",
  );
  if (!root) {
    throw new TypeError("Bridge configuration has no remote primary root");
  }
  return root;
}

function remotePolicy(config: BridgeConfig): string {
  const primaryRoot = remotePrimaryRoot(config);
  const target = [
    "Remote workspace identity:",
    `- Host: ${config.host}`,
    `- Root id: ${primaryRoot.id}`,
    "- Target: remote",
    "- Role: primary",
    `- Path: ${primaryRoot.path}`,
  ].join("\n");
  return [REMOTE_INSTRUCTIONS, target].join("\n\n");
}

function mergeInstructions(existing: unknown, config: BridgeConfig): string {
  return [remotePolicy(config), typeof existing === "string" ? existing : ""]
    .filter(Boolean)
    .join("\n\n");
}

function mergeAdditionalContext(
  existing: unknown,
  config: BridgeConfig,
): Record<string, unknown> {
  return {
    ...(isRecord(existing) ? existing : {}),
    [REMOTE_TURN_CONTEXT_KEY]: {
      kind: "application",
      value: remotePolicy(config),
    },
  };
}

function mergeDynamicTools(existing: unknown): unknown[] {
  const current = Array.isArray(existing)
    ? existing.filter(
        (tool) =>
          !isRecord(tool) ||
          typeof tool.name !== "string" ||
          !REMOTE_TOOL_NAMES.has(tool.name),
      )
    : [];
  return [...current, ...REMOTE_DYNAMIC_TOOLS];
}

function withoutPermissionProfile(params: Record<string, unknown>): Record<string, unknown> {
  const rewritten = { ...params };
  if (params.permissions === "full-access" && params.approvalPolicy === undefined) {
    rewritten.approvalPolicy = "never";
  }
  delete rewritten.permissions;
  return rewritten;
}

export function rewriteClientMessage(
  message: RpcMessage,
  config: BridgeConfig | null,
  controlDir: string,
): RpcMessage {
  if (!("method" in message) || !isRecord(message.params)) {
    return message;
  }

  if (message.method === "initialize") {
    const capabilities = isRecord(message.params.capabilities)
      ? message.params.capabilities
      : {};
    return {
      ...message,
      params: {
        ...message.params,
        capabilities: {
          ...capabilities,
          experimentalApi: true,
        },
      },
    };
  }

  if (message.method === "thread/start") {
    return {
      ...message,
      params: {
        ...withoutPermissionProfile(message.params),
        cwd: controlDir,
        runtimeWorkspaceRoots: [config ? remotePrimaryRoot(config).path : controlDir],
        sandbox: "read-only",
        ...(config
          ? {
              developerInstructions: mergeInstructions(
                message.params.developerInstructions,
                config,
              ),
              dynamicTools: mergeDynamicTools(message.params.dynamicTools),
            }
          : {}),
      },
    };
  }

  if (message.method === "thread/resume") {
    return {
      ...message,
      params: {
        ...withoutPermissionProfile(message.params),
        cwd: controlDir,
        runtimeWorkspaceRoots: [config ? remotePrimaryRoot(config).path : controlDir],
        sandbox: "read-only",
        ...(config
          ? {
              developerInstructions: mergeInstructions(
                message.params.developerInstructions,
                config,
              ),
            }
          : {}),
      },
    };
  }

  if (message.method === "turn/start") {
    return {
      ...message,
      params: {
        ...withoutPermissionProfile(message.params),
        cwd: controlDir,
        runtimeWorkspaceRoots: [config ? remotePrimaryRoot(config).path : controlDir],
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
        ...(config
          ? {
              additionalContext: mergeAdditionalContext(
                message.params.additionalContext,
                config,
              ),
            }
          : {}),
      },
    };
  }

  return message;
}
