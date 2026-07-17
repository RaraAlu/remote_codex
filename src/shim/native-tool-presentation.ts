import { basename } from "node:path";
import type { BridgeConfig } from "../core/types.js";
import { normalizeRemotePath } from "../core/path-policy.js";
import { REMOTE_TOOL_NAMES } from "./dynamic-tools.js";
import { formatRemoteExecRequest, parseRemoteExecArguments } from "./remote-command.js";
import { isRecord } from "./rpc.js";

interface NativeCommandPresentation {
  command: string;
  commandActions: Array<Record<string, unknown>>;
  cwd?: string;
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function displayPath(config: BridgeConfig, value: unknown): string {
  if (typeof value !== "string") {
    return config.workspaceRoot;
  }
  try {
    return normalizeRemotePath(config.workspaceRoot, value).absolutePath;
  } catch {
    return config.workspaceRoot;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function commandPresentation(
  tool: string,
  rawArguments: unknown,
  config: BridgeConfig,
): NativeCommandPresentation {
  const args = toolArguments(rawArguments);
  const path = displayPath(config, args.path);

  switch (tool) {
    case "remote_read_file": {
      const command = `sed -n '1,240p' -- ${shellQuote(path)}`;
      return {
        command,
        commandActions: [
          {
            type: "read",
            command,
            name: basename(path),
            path,
          },
        ],
      };
    }
    case "remote_list_directory": {
      const command = `find ${shellQuote(path)} -maxdepth 1 -mindepth 1`;
      return {
        command,
        commandActions: [{ type: "listFiles", command, path }],
      };
    }
    case "remote_list_tree": {
      const depth =
        typeof args.depth === "number" && Number.isInteger(args.depth)
          ? Math.max(1, Math.min(args.depth, 4))
          : 2;
      const command = `find ${shellQuote(path)} -maxdepth ${depth} -mindepth 1`;
      return {
        command,
        commandActions: [{ type: "listFiles", command, path }],
      };
    }
    case "remote_search": {
      const query = typeof args.query === "string" ? args.query : "";
      const paths = Array.isArray(args.paths)
        ? args.paths.map((entry) => displayPath(config, entry))
        : [config.workspaceRoot];
      const command = `rg -n -- ${shellQuote(query)} ${paths.map(shellQuote).join(" ")}`;
      return {
        command,
        commandActions: [
          {
            type: "search",
            command,
            path: paths.length === 1 ? paths[0] : config.workspaceRoot,
            query,
          },
        ],
      };
    }
    case "remote_git_status": {
      const command = "git status --short --branch";
      return {
        command,
        commandActions: [{ type: "unknown", command }],
      };
    }
    case "remote_exec": {
      try {
        const request = parseRemoteExecArguments(args);
        const command = formatRemoteExecRequest(request);
        return {
          command,
          commandActions: [{ type: "unknown", command }],
          cwd: displayPath(config, request.cwd),
        };
      } catch {
        const command = "remote command";
        return {
          command,
          commandActions: [{ type: "unknown", command }],
        };
      }
    }
    default: {
      const command = tool;
      return {
        command,
        commandActions: [{ type: "unknown", command }],
      };
    }
  }
}

function textResult(item: Record<string, unknown>): unknown {
  if (!Array.isArray(item.contentItems)) {
    return null;
  }
  const textItem = item.contentItems.find(
    (entry) => isRecord(entry) && entry.type === "inputText" && typeof entry.text === "string",
  );
  if (!isRecord(textItem) || typeof textItem.text !== "string") {
    return null;
  }
  try {
    return JSON.parse(textItem.text) as unknown;
  } catch {
    return textItem.text;
  }
}

function readableFileOutput(data: Record<string, unknown>): string | null {
  if (typeof data.contentBase64 !== "string") {
    return null;
  }
  const content = Buffer.from(data.contentBase64, "base64");
  if (content.includes(0)) {
    const size = typeof data.size === "number" ? data.size : content.length;
    return `[binary file, ${size} bytes]`;
  }
  return content.toString("utf8");
}

function formatToolOutput(tool: string, item: Record<string, unknown>): string | null {
  const result = textResult(item);
  if (!isRecord(result)) {
    return typeof result === "string" ? result : null;
  }
  if (result.ok === false) {
    const error = isRecord(result.error) ? result.error : null;
    return typeof error?.message === "string" ? error.message : "Remote operation failed";
  }

  const data = result.data;
  if (tool === "remote_read_file" && isRecord(data)) {
    return readableFileOutput(data);
  }
  if (tool === "remote_list_directory" && Array.isArray(data)) {
    return data
      .filter(isRecord)
      .map((entry) => {
        const name = typeof entry.name === "string" ? entry.name : "";
        return entry.type === "directory" ? `${name}/` : name;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (tool === "remote_list_tree" && isRecord(data) && Array.isArray(data.entries)) {
    return data.entries
      .filter(isRecord)
      .map((entry) => {
        const path = typeof entry.path === "string" ? entry.path : "";
        return entry.type === "directory" ? `${path}/` : path;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (tool === "remote_search" && Array.isArray(data)) {
    return data
      .filter(isRecord)
      .map((match) => {
        const path = typeof match.path === "string" ? match.path : "";
        const lineNumber = typeof match.lineNumber === "number" ? match.lineNumber : "";
        const lines = typeof match.lines === "string" ? match.lines.replace(/\n$/, "") : "";
        return `${path}:${lineNumber}:${lines}`;
      })
      .join("\n");
  }
  if (tool === "remote_git_status" && isRecord(data)) {
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    return `${stdout}${stderr}`;
  }
  if (tool === "remote_exec" && isRecord(data)) {
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    return `${stdout}${stderr}`;
  }
  return data == null ? null : JSON.stringify(data, null, 2);
}

function projectDynamicToolItem(
  item: Record<string, unknown>,
  config: BridgeConfig,
): Record<string, unknown> {
  const tool = item.tool as string;
  const presentation = commandPresentation(tool, item.arguments, config);
  const completed = item.status !== "inProgress";
  const failed = item.status === "failed" || item.success === false;

  return {
    id: item.id,
    type: "commandExecution",
    command: presentation.command,
    commandActions: presentation.commandActions,
    cwd: presentation.cwd ?? config.workspaceRoot,
    status: completed ? (failed ? "failed" : "completed") : "inProgress",
    aggregatedOutput: completed ? formatToolOutput(tool, item) : null,
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
    exitCode: completed ? (failed ? 1 : 0) : null,
    processId: null,
    source: "agent",
  };
}

function projectValue(value: unknown, config: BridgeConfig): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const projected = value.map((entry) => {
      const next = projectValue(entry, config);
      changed ||= next !== entry;
      return next;
    });
    return changed ? projected : value;
  }
  if (!isRecord(value)) {
    return value;
  }
  if (
    value.type === "dynamicToolCall" &&
    typeof value.id === "string" &&
    typeof value.tool === "string" &&
    REMOTE_TOOL_NAMES.has(value.tool)
  ) {
    return projectDynamicToolItem(value, config);
  }

  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = projectValue(entry, config);
    projected[key] = next;
    changed ||= next !== entry;
  }
  return changed ? projected : value;
}

export function projectServerMessage<T>(message: T, config: BridgeConfig | null): T {
  if (!config) {
    return message;
  }
  return projectValue(message, config) as T;
}
