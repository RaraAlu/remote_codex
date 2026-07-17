import type { BridgeConfig } from "../core/types.js";
import { REMOTE_DYNAMIC_TOOLS, REMOTE_TOOL_NAMES } from "./dynamic-tools.js";
import { isRecord, type RpcMessage } from "./rpc.js";

const REMOTE_INSTRUCTIONS = `Codex Remote Bridge execution policy:
- The project exists only on the configured remote Ubuntu host.
- Use only remote_* dynamic tools for project files, search, Git, tests, and commands.
- Never use local shell or local filesystem tools for project operations.
- The local cwd is an empty control directory and is not the project.
- When a required remote capability is unavailable, stop and report that the bridge does not support it. Never fall back to local execution.`;

function mergeInstructions(existing: unknown, config: BridgeConfig): string {
  const target = `Remote target: ${config.host}:${config.workspaceRoot}`;
  return [REMOTE_INSTRUCTIONS, target, typeof existing === "string" ? existing : ""]
    .filter(Boolean)
    .join("\n\n");
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
        ...message.params,
        cwd: controlDir,
        runtimeWorkspaceRoots: [controlDir],
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
        ...message.params,
        cwd: controlDir,
        runtimeWorkspaceRoots: [controlDir],
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

  return message;
}
