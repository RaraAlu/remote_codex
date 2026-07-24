import {
  basename,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { BridgeConfig, WorkspaceRootConfig } from "../core/types.js";
import { normalizeRemotePath } from "../core/path-policy.js";
import {
  normalizeWorkspaceToolName,
  REMOTE_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from "./dynamic-tools.js";
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

function selectedRoot(
  config: BridgeConfig,
  tool: string,
  args: Record<string, unknown>,
): WorkspaceRootConfig {
  const primary = config.roots.find(
    (root) => root.target === "remote" && root.role === "primary",
  );
  if (!primary) {
    throw new TypeError("Bridge configuration has no remote primary root");
  }
  if (!WORKSPACE_TOOL_NAMES.has(tool)) {
    return primary;
  }
  const target = args.target === "local" ? "local" : "remote";
  const rootId = typeof args.rootId === "string" ? args.rootId : primary.id;
  return (
    config.roots.find((root) => root.id === rootId && root.target === target) ??
    primary
  );
}

function displayPath(root: WorkspaceRootConfig, value: unknown): string {
  if (typeof value !== "string") {
    return root.path;
  }
  try {
    if (root.target === "remote") {
      return normalizeRemotePath(root.path, value).absolutePath;
    }
    const path = resolve(root.path, value || ".");
    const child = relative(root.path, path);
    if (
      child !== "" &&
      (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    ) {
      return root.path;
    }
    return path;
  } catch {
    return root.path;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function workspaceCommand(
  root: WorkspaceRootConfig,
  operation: string,
  values: readonly string[] = [],
): string {
  return [
    "codex-bridge",
    operation,
    "--target",
    root.target,
    "--root",
    shellQuote(root.id),
    ...values,
  ].join(" ");
}

function commandPresentation(
  tool: string,
  rawArguments: unknown,
  config: BridgeConfig,
): NativeCommandPresentation {
  const args = toolArguments(rawArguments);
  const normalizedTool = normalizeWorkspaceToolName(tool);
  const root = selectedRoot(config, tool, args);
  const path = displayPath(root, args.path);

  switch (normalizedTool) {
    case "workspace_write_file": {
      const command = workspaceCommand(root, "write", ["--", shellQuote(path)]);
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
    }
    case "workspace_apply_patch": {
      const command = workspaceCommand(root, "patch", ["--", shellQuote(path)]);
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
    }
    case "workspace_create_directory": {
      const command = workspaceCommand(root, "mkdir", ["--", shellQuote(path)]);
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
    }
    case "workspace_rename_path": {
      const destination = displayPath(root, args.destinationPath);
      const command = workspaceCommand(root, "rename", [
        "--",
        shellQuote(path),
        shellQuote(destination),
      ]);
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
    }
    case "workspace_delete_path": {
      const command = workspaceCommand(root, "delete", ["--", shellQuote(path)]);
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
    }
    case "workspace_read_file": {
      const command = workspaceCommand(root, "read", ["--", shellQuote(path)]);
      return {
        command,
        commandActions: [
          {
            type: "read",
            command,
            name: root.target === "remote" ? posix.basename(path) : basename(path),
            path,
          },
        ],
        cwd: root.path,
      };
    }
    case "workspace_list_directory": {
      const command = workspaceCommand(root, "list", ["--", shellQuote(path)]);
      return {
        command,
        commandActions: [{ type: "listFiles", command, path }],
        cwd: root.path,
      };
    }
    case "workspace_list_tree": {
      const depth =
        typeof args.depth === "number" && Number.isInteger(args.depth)
          ? Math.max(1, Math.min(args.depth, 4))
          : 2;
      const command = workspaceCommand(root, "tree", [
        "--depth",
        String(depth),
        "--",
        shellQuote(path),
      ]);
      return {
        command,
        commandActions: [{ type: "listFiles", command, path }],
        cwd: root.path,
      };
    }
    case "workspace_search": {
      const query = typeof args.query === "string" ? args.query : "";
      const paths = Array.isArray(args.paths)
        ? args.paths.map((entry) => displayPath(root, entry))
        : [root.path];
      const command = workspaceCommand(root, "search", [
        "--literal",
        shellQuote(query),
        "--",
        ...paths.map(shellQuote),
      ]);
      return {
        command,
        commandActions: [
          {
            type: "search",
            command,
            path: paths.length === 1 ? paths[0] : root.path,
            query,
          },
        ],
        cwd: root.path,
      };
    }
    case "workspace_git_status": {
      const command = workspaceCommand(root, "status");
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
    }
    case "remote_exec": {
      try {
        const request = parseRemoteExecArguments(args);
        const command = formatRemoteExecRequest(request);
        return {
          command,
          commandActions: [{ type: "unknown", command }],
          cwd: displayPath(root, request.cwd),
        };
      } catch {
        const command = "remote command";
        return {
          command,
          commandActions: [{ type: "unknown", command }],
        };
      }
    }
    case "remote_background_start": {
      try {
        const request = parseRemoteExecArguments(args, 24 * 60 * 60_000);
        const command = `codex-bridge background start -- ${formatRemoteExecRequest(request)}`;
        return {
          command,
          commandActions: [{ type: "unknown", command }],
          cwd: displayPath(root, request.cwd),
        };
      } catch {
        const command = "codex-bridge background start";
        return {
          command,
          commandActions: [{ type: "unknown", command }],
          cwd: root.path,
        };
      }
    }
    case "remote_background_status":
    case "remote_background_log":
    case "remote_background_cancel": {
      const operation = normalizedTool.replace("remote_background_", "");
      const taskId = typeof args.taskId === "string" ? args.taskId : "unknown";
      const command = `codex-bridge background ${operation} ${shellQuote(taskId)}`;
      return {
        command,
        commandActions: [{ type: "unknown", command }],
        cwd: root.path,
      };
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
  const normalizedTool = normalizeWorkspaceToolName(tool);
  const result = textResult(item);
  if (!isRecord(result)) {
    return typeof result === "string" ? result : null;
  }
  if (result.ok === false) {
    const error = isRecord(result.error) ? result.error : null;
    return typeof error?.message === "string" ? error.message : "Workspace operation failed";
  }

  const data = result.data;
  if (
    (normalizedTool === "workspace_write_file" ||
      normalizedTool === "workspace_apply_patch" ||
      normalizedTool === "workspace_create_directory" ||
      normalizedTool === "workspace_rename_path" ||
      normalizedTool === "workspace_delete_path") &&
    isRecord(data)
  ) {
    const operation =
      typeof data.operation === "string" ? data.operation : normalizedTool;
    const canonicalPath =
      typeof data.destinationCanonicalPath === "string"
        ? data.destinationCanonicalPath
        : typeof data.canonicalPath === "string"
          ? data.canonicalPath
          : "";
    const bytesWritten =
      typeof data.bytesWritten === "number" ? ` (${data.bytesWritten} bytes)` : "";
    return `${operation}: ${canonicalPath}${bytesWritten}`;
  }
  if (normalizedTool === "workspace_read_file" && isRecord(data)) {
    return readableFileOutput(data);
  }
  if (normalizedTool === "workspace_list_directory") {
    const entries = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.entries)
        ? data.entries
        : [];
    return entries
      .filter(isRecord)
      .map((entry) => {
        const name = typeof entry.name === "string" ? entry.name : "";
        return entry.type === "directory" ? `${name}/` : name;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (
    normalizedTool === "workspace_list_tree" &&
    isRecord(data) &&
    Array.isArray(data.entries)
  ) {
    return data.entries
      .filter(isRecord)
      .map((entry) => {
        const path = typeof entry.path === "string" ? entry.path : "";
        return entry.type === "directory" ? `${path}/` : path;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (normalizedTool === "workspace_search") {
    const matches = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.matches)
        ? data.matches
        : [];
    return matches
      .filter(isRecord)
      .map((match) => {
        const path = typeof match.path === "string" ? match.path : "";
        const lineNumber = typeof match.lineNumber === "number" ? match.lineNumber : "";
        const lines = typeof match.lines === "string" ? match.lines.replace(/\n$/, "") : "";
        return `${path}:${lineNumber}:${lines}`;
      })
      .join("\n");
  }
  if (normalizedTool === "workspace_git_status" && isRecord(data)) {
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    return `${stdout}${stderr}`;
  }
  if (normalizedTool === "remote_exec" && isRecord(data)) {
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    return `${stdout}${stderr}`;
  }
  if (
    (normalizedTool === "remote_background_start" ||
      normalizedTool === "remote_background_status" ||
      normalizedTool === "remote_background_cancel") &&
    isRecord(data)
  ) {
    const taskId = typeof data.taskId === "string" ? data.taskId : "unknown";
    const status = typeof data.status === "string" ? data.status : "unknown";
    const exitCode =
      typeof data.exitCode === "number" ? `, exit ${data.exitCode}` : "";
    return `${taskId}: ${status}${exitCode}`;
  }
  if (
    normalizedTool === "remote_background_log" &&
    isRecord(data) &&
    Array.isArray(data.events)
  ) {
    const output = data.events
      .filter(isRecord)
      .map((event) => {
        if (typeof event.contentBase64 !== "string") {
          return "";
        }
        const content = Buffer.from(event.contentBase64, "base64").toString("utf8");
        return event.channel === "stderr" ? `[stderr] ${content}` : content;
      })
      .join("");
    return `${data.truncated === true ? "[earlier output truncated]\n" : ""}${output}`;
  }
  return data == null ? null : JSON.stringify(data, null, 2);
}

function completedCommandState(
  tool: string,
  item: Record<string, unknown>,
): { exitCode: number | null; failed: boolean } {
  const normalizedTool = normalizeWorkspaceToolName(tool);
  const result = textResult(item);
  const resultRecord = isRecord(result) ? result : null;
  const data = resultRecord && isRecord(resultRecord.data) ? resultRecord.data : null;
  const error = resultRecord && isRecord(resultRecord.error) ? resultRecord.error : null;
  const details = error && isRecord(error.details) ? error.details : null;
  const commandResult =
    normalizedTool === "remote_exec" || normalizedTool === "workspace_git_status"
      ? (data ?? details)
      : null;

  let exitCode: number | null | undefined;
  if (commandResult && "exitCode" in commandResult) {
    exitCode =
      typeof commandResult.exitCode === "number" ? commandResult.exitCode : null;
  }
  const signal = commandResult?.signal;
  const failed =
    item.status === "failed" ||
    item.success === false ||
    resultRecord?.ok === false ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    (exitCode === null && typeof signal === "string" && signal.length > 0);

  return {
    exitCode: exitCode === undefined ? (failed ? 1 : 0) : exitCode,
    failed,
  };
}

function projectDynamicToolItem(
  item: Record<string, unknown>,
  config: BridgeConfig,
): Record<string, unknown> {
  const tool = item.tool as string;
  const presentation = commandPresentation(tool, item.arguments, config);
  const completed = item.status !== "inProgress";
  const commandState = completed ? completedCommandState(tool, item) : null;

  return {
    id: item.id,
    type: "commandExecution",
    command: presentation.command,
    commandActions: presentation.commandActions,
    cwd: presentation.cwd ?? config.workspaceRoot,
    status: completed ? (commandState?.failed ? "failed" : "completed") : "inProgress",
    aggregatedOutput: completed ? formatToolOutput(tool, item) : null,
    durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
    exitCode: commandState?.exitCode ?? null,
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
