import { randomUUID } from "node:crypto";
import { asBridgeError, BridgeError } from "../core/errors.js";
import type { AuditLog } from "../core/audit-log.js";
import type { OpenSshExecutor } from "../core/ssh-executor.js";
import type {
  BridgeClientIdentity,
  BridgeConfig,
  ConversationResourceConfig,
  ToolRequestContext,
  ToolResult,
  WorkspaceToolRoot,
} from "../core/types.js";
import type { ControllerWorkspaceClient } from "../core/vscode-transport.js";
import type { WorkspaceExecutor } from "../core/workspace-executor.js";
import { ControllerWorkspaceExecutor } from "./controller-workspace-executor.js";
import { isRecord, type RpcId } from "./rpc.js";
import { parseRemoteExecArguments } from "./remote-command.js";

const LEGACY_REMOTE_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["remote_read_file", "workspace_read_file"],
  ["remote_list_directory", "workspace_list_directory"],
  ["remote_list_tree", "workspace_list_tree"],
  ["remote_search", "workspace_search"],
  ["remote_git_status", "workspace_git_status"],
] as const);

export const WORKSPACE_TOOL_NAMES = new Set([
  "workspace_apply_patch",
  "workspace_create_directory",
  "workspace_delete_path",
  "workspace_open_file",
  "workspace_read_file",
  "workspace_list_directory",
  "workspace_list_tree",
  "workspace_rename_path",
  "workspace_search",
  "workspace_show_diff",
  "workspace_git_status",
  "workspace_write_file",
]);

export const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  "workspace_apply_patch",
  "workspace_create_directory",
  "workspace_delete_path",
  "workspace_rename_path",
  "workspace_write_file",
]);

export const WORKSPACE_RESOURCE_TOOL_NAMES = new Set([
  "workspace_open_file",
  "workspace_show_diff",
]);

export const REMOTE_BACKGROUND_TOOL_NAMES = new Set([
  "remote_background_start",
  "remote_background_status",
  "remote_background_log",
  "remote_background_cancel",
]);

export const REMOTE_TOOL_NAMES = new Set([
  ...WORKSPACE_TOOL_NAMES,
  ...LEGACY_REMOTE_TOOL_ALIASES.keys(),
  ...REMOTE_BACKGROUND_TOOL_NAMES,
  "remote_exec",
]);

export function normalizeWorkspaceToolName(tool: string): string {
  return LEGACY_REMOTE_TOOL_ALIASES.get(tool) ?? tool;
}

const ROOT_INPUT_PROPERTIES = {
  target: {
    type: "string",
    enum: ["local", "remote"],
    description: "Explicit workspace target. Defaults to the remote primary root.",
  },
  rootId: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    description: "Configured root ID. Required when target is local.",
  },
} as const;

const REMOTE_ROOT_INPUT_PROPERTIES = {
  target: {
    type: "string",
    enum: ["remote"],
    description: "Remote command target.",
  },
  rootId: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    description: "Configured remote primary root ID.",
  },
} as const;

export const REMOTE_DYNAMIC_TOOLS = [
  {
    type: "function",
    name: "remote_background_start",
    description:
      "Start one tracked non-interactive command in the remote primary workspace. Returns a taskId for status, log, and cancellation. Requires the active VS Code Remote transport.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["argv"],
      properties: {
        ...REMOTE_ROOT_INPUT_PROPERTIES,
        argv: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: { type: "string" },
        },
        cwd: {
          type: "string",
          description: "Optional workspace-relative remote working directory.",
        },
        env: {
          type: "object",
          additionalProperties: { type: ["string", "null"] },
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 86400000,
          description: "Tracked task lifetime, up to 24 hours. Defaults to 1 hour.",
        },
      },
    },
  },
  {
    type: "function",
    name: "remote_background_status",
    description:
      "Read the current state and log cursors of a tracked remote background task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        ...REMOTE_ROOT_INPUT_PROPERTIES,
        taskId: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  },
  {
    type: "function",
    name: "remote_background_log",
    description:
      "Read a bounded stdout/stderr page from a tracked remote background task using a byte cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        ...REMOTE_ROOT_INPUT_PROPERTIES,
        taskId: { type: "string", minLength: 1, maxLength: 64 },
        cursor: { type: "integer", minimum: 0 },
        limitBytes: {
          type: "integer",
          minimum: 1,
          maximum: 262144,
        },
      },
    },
  },
  {
    type: "function",
    name: "remote_background_cancel",
    description:
      "Cancel a tracked remote background task and its POSIX process group.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        ...REMOTE_ROOT_INPUT_PROPERTIES,
        taskId: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  },
  {
    type: "function",
    name: "workspace_write_file",
    description:
      "Atomically create or replace a bounded file in an explicitly selected workspace root. Existing files require the SHA-256 expectedHash returned by workspace_read_file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "contentBase64"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "File path within the selected root." },
        contentBase64: {
          type: "string",
          description: "Complete replacement content encoded as base64, up to 1 MiB.",
        },
        expectedHash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description:
            "Required for replacement and forbidden for creation. Must match the latest read.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_apply_patch",
    description:
      "Apply bounded, exact, unambiguous UTF-8 text replacements and atomically replace the file. Always requires expectedHash.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "expectedHash", "replacements"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "Text file path within the selected root." },
        expectedHash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
        },
        replacements: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["oldText", "newText"],
            properties: {
              oldText: { type: "string", minLength: 1 },
              newText: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_create_directory",
    description:
      "Create one directory below an existing parent in an explicitly selected workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "New directory path within the selected root." },
      },
    },
  },
  {
    type: "function",
    name: "workspace_rename_path",
    description:
      "Atomically rename a file or directory without overwriting the destination. Files require expectedHash.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "destinationPath"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "Existing source path." },
        destinationPath: { type: "string", description: "Nonexistent destination path." },
        expectedHash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description: "Required when the source is a file.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_delete_path",
    description:
      "Delete a regular file or empty directory. Files require expectedHash; recursive deletion is not supported.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "Existing file or empty directory path." },
        expectedHash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description: "Required when deleting a file.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_open_file",
    description:
      "Open a verified workspace file in the active VS Code editor, optionally selecting a one-based line and column range. Requires the active VS Code Remote transport.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "File path within the selected root." },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        endColumn: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    type: "function",
    name: "workspace_show_diff",
    description:
      "Open a VS Code Diff between a verified prior UTF-8 snapshot and the current workspace file. Requires the active VS Code Remote transport.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "beforeContentBase64", "beforeHash"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "File path within the selected root." },
        beforeContentBase64: {
          type: "string",
          description:
            "Prior complete UTF-8 file content from workspace_read_file, encoded as base64, up to 1 MiB.",
        },
        beforeHash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description: "SHA-256 hash returned with the prior file content.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional single-line Diff editor title.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_read_file",
    description:
      "Read a file from an explicitly selected authorized local or remote workspace root. Returns base64 content and verified metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "Path within the selected workspace root." },
        limitBytes: {
          type: "integer",
          minimum: 1,
          maximum: 5_242_880,
          description: "Maximum raw bytes to return.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_list_directory",
    description:
      "List direct children in an explicitly selected authorized local or remote workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "Directory within the selected workspace root." },
      },
    },
  },
  {
    type: "function",
    name: "workspace_list_tree",
    description:
      "Inspect a bounded directory tree in an explicitly selected authorized local or remote workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        path: { type: "string", description: "Directory within the selected workspace root." },
        depth: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Maximum descendant depth. Defaults to 2.",
        },
        maxEntries: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          description: "Maximum returned entries. Defaults to 400.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_search",
    description:
      "Search for literal text in an explicitly selected authorized local or remote workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        ...ROOT_INPUT_PROPERTIES,
        query: { type: "string", description: "Case-sensitive literal text." },
        paths: {
          type: "array",
          items: { type: "string" },
          maxItems: 32,
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_git_status",
    description:
      "Run fixed read-only Git status in an explicitly selected authorized local or remote workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...ROOT_INPUT_PROPERTIES,
      },
    },
  },
  {
    type: "function",
    name: "remote_exec",
    description:
      "Run an argv command in the configured remote Ubuntu workspace over SSH. Use for Git, tests, training, diagnostics, and GPU commands. Approval follows the active Codex permission mode; full access runs without an extra prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["argv"],
      properties: {
        ...REMOTE_ROOT_INPUT_PROPERTIES,
        argv: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: { type: "string" },
          description:
            "Structured remote command argv. Use ['bash','-lc','...'] only when shell syntax is required.",
        },
        cwd: {
          type: "string",
          description:
            "Optional workspace-relative remote working directory. Defaults to the workspace root.",
        },
        env: {
          type: "object",
          additionalProperties: { type: ["string", "null"] },
          description: "Explicit remote environment overrides. Local process variables are not inherited.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 3600000,
        },
      },
    },
  },
] as const;

interface DynamicToolCall {
  arguments: unknown;
  callId: string;
  tool: string;
}

export interface DynamicToolObserver {
  clientIdentity?: BridgeClientIdentity;
  conversationResources?: readonly ConversationResourceConfig[];
  coordinationWaitMs?: number;
  idempotencyKey?: string;
  onOutput?: (chunk: string) => void;
  operationId?: string;
  signal?: AbortSignal;
  threadId?: string;
}

function parseToolCall(value: unknown): DynamicToolCall {
  if (
    !isRecord(value) ||
    typeof value.callId !== "string" ||
    typeof value.tool !== "string" ||
    !("arguments" in value)
  ) {
    throw new BridgeError("PROTOCOL_MISMATCH", "Invalid dynamic tool call parameters");
  }
  return {
    arguments: value.arguments,
    callId: value.callId,
    tool: value.tool,
  };
}

function argumentObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BridgeError("PROTOCOL_MISMATCH", "Dynamic tool arguments must be an object");
  }
  return value;
}

function requiredPath(args: Record<string, unknown>): string {
  if (typeof args.path !== "string") {
    throw new BridgeError("PROTOCOL_MISMATCH", "path must be a string");
  }
  return args.path;
}

function isControllerWorkspaceClient(value: unknown): value is ControllerWorkspaceClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestControllerWorkspace" in value &&
    typeof value.requestControllerWorkspace === "function"
  );
}

export class DynamicToolRouter {
  readonly #audit: AuditLog;
  readonly #config: BridgeConfig;
  readonly #controllerWorkspace: ControllerWorkspaceClient | null;
  readonly #executor: OpenSshExecutor;

  constructor(config: BridgeConfig, executor: OpenSshExecutor, audit: AuditLog) {
    this.#config = config;
    this.#executor = executor;
    this.#controllerWorkspace = isControllerWorkspaceClient(executor)
      ? executor
      : null;
    this.#audit = audit;
  }

  async handle(
    rpcId: RpcId,
    rawParams: unknown,
    observer: DynamicToolObserver = {},
  ): Promise<unknown> {
    const call = parseToolCall(rawParams);
    if (!REMOTE_TOOL_NAMES.has(call.tool)) {
      throw new BridgeError("COMMAND_DENIED", `Unknown remote tool: ${call.tool}`);
    }
    const args = argumentObject(call.arguments);
    const root = this.#requestedRoot(args, observer.conversationResources);
    const context = this.#toolContext(root, false);

    const requestId = call.callId || `req_${randomUUID()}`;
    const startedAt = performance.now();
    await this.#audit.write({
      requestId,
      operationId: observer.operationId ?? requestId,
      ...observer.clientIdentity,
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      workspaceRoot: this.#config.workspaceRoot,
      ...(root.target === "remote" ? { remoteCwd: root.path } : {}),
      rootId: root.id,
      rootRole: root.role,
      rootPath: root.path,
      target: root.target,
      operation: call.tool,
      outcome: "started",
      details: {
        rpcId,
        ...(WORKSPACE_MUTATION_TOOL_NAMES.has(call.tool)
          ? this.#mutationAuditDetails(args)
          : {}),
        ...(WORKSPACE_RESOURCE_TOOL_NAMES.has(call.tool)
          ? this.#resourceAuditDetails(args)
          : {}),
      },
    });

    try {
      if (observer.signal?.aborted) {
        throw new BridgeError("CANCELLED", "Workspace tool call was cancelled");
      }
      const data = await this.#attachWorkspaceResource(
        call.tool,
        await this.#execute(call.tool, args, root, observer),
        root,
        observer.threadId,
      );
      if (observer.signal?.aborted) {
        throw new BridgeError("CANCELLED", "Workspace tool call was cancelled");
      }
      const truncated = isRecord(data) && data.truncated === true;
      const result: ToolResult<unknown> = {
        ok: true,
        requestId,
        ...context,
        rootPath: root.path,
        remoteCwd: root.target === "remote" ? root.path : null,
        data,
        truncated,
        error: null,
      };
      await this.#audit.write({
        requestId,
        operationId: observer.operationId ?? requestId,
        ...observer.clientIdentity,
        connectionId: this.#executor.connectionId,
        hostId: this.#config.host,
        workspaceRoot: this.#config.workspaceRoot,
        ...(root.target === "remote" ? { remoteCwd: root.path } : {}),
        rootId: root.id,
        rootRole: root.role,
        rootPath: root.path,
        target: root.target,
        operation: call.tool,
        outcome: "succeeded",
        durationMs: Math.round(performance.now() - startedAt),
        ...(isRecord(data)
          ? {
              details: {
                ...(observer.coordinationWaitMs === undefined
                  ? {}
                  : { coordinationWaitMs: observer.coordinationWaitMs }),
                ...(typeof data.durationMs === "number"
                  ? { remoteDurationMs: data.durationMs }
                  : {}),
                ...(isRecord(data.transportTiming)
                  ? { transportTiming: data.transportTiming }
                  : {}),
                ...(typeof data.bytesWritten === "number"
                  ? { bytesWritten: data.bytesWritten }
                  : {}),
                ...(typeof data.idempotencyOutcome === "string"
                  ? { idempotencyOutcome: data.idempotencyOutcome }
                  : {}),
                ...(typeof data.hash === "string"
                  ? { newHash: data.hash }
                  : {}),
                ...(REMOTE_BACKGROUND_TOOL_NAMES.has(call.tool)
                  ? this.#backgroundAuditDetails(args, data)
                  : {}),
                ...(WORKSPACE_MUTATION_TOOL_NAMES.has(call.tool)
                  ? this.#mutationAuditDetails(args)
                  : {}),
                ...(WORKSPACE_RESOURCE_TOOL_NAMES.has(call.tool)
                  ? this.#resourceAuditDetails(args, data)
                  : {}),
              },
            }
          : {}),
      });
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      };
    } catch (error) {
      const bridgeError = asBridgeError(error, "SSH_DISCONNECTED");
      const result: ToolResult<never> = {
        ok: false,
        requestId,
        ...context,
        remoteCwd: root.target === "remote" ? root.path : null,
        data: null,
        truncated: bridgeError.code === "OUTPUT_TRUNCATED",
        error: bridgeError.toPayload(),
      };
      await this.#audit.write({
        requestId,
        operationId: observer.operationId ?? requestId,
        ...observer.clientIdentity,
        connectionId: this.#executor.connectionId,
        hostId: this.#config.host,
        workspaceRoot: this.#config.workspaceRoot,
        ...(root.target === "remote" ? { remoteCwd: root.path } : {}),
        rootId: root.id,
        rootRole: root.role,
        rootPath: root.path,
        target: root.target,
        operation: call.tool,
        outcome:
          bridgeError.code === "RESULT_UNKNOWN"
            ? "unknown"
            : bridgeError.code === "CANCELLED"
              ? "cancelled"
              : "failed",
        durationMs: Math.round(performance.now() - startedAt),
        details: {
          error: bridgeError.toPayload(),
          ...(REMOTE_BACKGROUND_TOOL_NAMES.has(call.tool)
            ? this.#backgroundAuditDetails(args)
            : {}),
          ...(WORKSPACE_MUTATION_TOOL_NAMES.has(call.tool)
            ? this.#mutationAuditDetails(args)
            : {}),
          ...(WORKSPACE_RESOURCE_TOOL_NAMES.has(call.tool)
            ? this.#resourceAuditDetails(args)
            : {}),
        },
      });
      return {
        success: false,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      };
    }
  }

  async decline(
    rpcId: RpcId,
    rawParams: unknown,
    reason: string,
    observer: DynamicToolObserver = {},
  ): Promise<unknown> {
    const call = parseToolCall(rawParams);
    const args = argumentObject(call.arguments);
    const root = this.#requestedRoot(args, observer.conversationResources);
    const context = this.#toolContext(root, false);
    const requestId = call.callId || `req_${randomUUID()}`;
    const error = new BridgeError("COMMAND_DENIED", reason);
    const result: ToolResult<never> = {
      ok: false,
      requestId,
      ...context,
      remoteCwd: root.target === "remote" ? root.path : null,
      data: null,
      truncated: false,
      error: error.toPayload(),
    };
    await this.#audit.write({
      requestId,
      operationId: observer.operationId ?? requestId,
      ...observer.clientIdentity,
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      workspaceRoot: this.#config.workspaceRoot,
      ...(root.target === "remote" ? { remoteCwd: root.path } : {}),
      rootId: root.id,
      rootRole: root.role,
      rootPath: root.path,
      target: root.target,
      operation: call.tool,
      outcome: "cancelled",
      details: { rpcId, reason },
    });
    return {
      success: false,
      contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
    };
  }

  async #execute(
    tool: string,
    args: Record<string, unknown>,
    root: WorkspaceToolRoot,
    observer: DynamicToolObserver,
  ): Promise<unknown> {
    if (tool === "remote_background_start") {
      this.#assertRemotePrimaryRoot(root);
      const request = parseRemoteExecArguments(args, 24 * 60 * 60_000);
      const taskId = `bg_${(observer.idempotencyKey ?? randomUUID()).slice(0, 32)}`;
      return await this.#executor.startBackgroundTask(
        taskId,
        request.argv,
        {
          cwd: request.cwd,
          env: request.env,
          idempotencyKey: observer.idempotencyKey,
          timeoutMs: request.timeoutMs,
          signal: observer.signal,
        },
      );
    }
    if (tool === "remote_background_status") {
      this.#assertRemotePrimaryRoot(root);
      return await this.#executor.backgroundTaskStatus(
        this.#requiredTaskId(args),
      );
    }
    if (tool === "remote_background_log") {
      this.#assertRemotePrimaryRoot(root);
      const cursor =
        typeof args.cursor === "number" && Number.isInteger(args.cursor)
          ? Math.max(0, args.cursor)
          : 0;
      const limitBytes =
        typeof args.limitBytes === "number" && Number.isInteger(args.limitBytes)
          ? Math.max(1, Math.min(args.limitBytes, 256 * 1024))
          : 256 * 1024;
      return await this.#executor.readBackgroundTaskLog(
        this.#requiredTaskId(args),
        cursor,
        limitBytes,
      );
    }
    if (tool === "remote_background_cancel") {
      this.#assertRemotePrimaryRoot(root);
      return await this.#executor.cancelBackgroundTask(
        this.#requiredTaskId(args),
      );
    }
    if (tool === "remote_exec") {
      this.#assertRemotePrimaryRoot(root);
      const request = parseRemoteExecArguments(args);
      return await this.#executor.execute(request.argv, {
        cwd: request.cwd,
        env: request.env,
        idempotencyKey: observer.idempotencyKey,
        timeoutMs: request.timeoutMs,
        sideEffect: true,
        signal: observer.signal,
        onStdout: observer.onOutput,
        onStderr: observer.onOutput,
      });
    }

    const normalizedTool = normalizeWorkspaceToolName(tool);
    const legacyResult = LEGACY_REMOTE_TOOL_ALIASES.has(tool);
    if (legacyResult) {
      this.#assertRemotePrimaryRoot(root);
    }
    if (
      root.role === "conversation" &&
      WORKSPACE_MUTATION_TOOL_NAMES.has(normalizedTool)
    ) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Resources shared with the active conversation are read-only",
        { rootId: root.id, threadId: observer.threadId },
      );
    }
    const executor = this.#workspaceExecutor(root, observer.threadId);
    switch (normalizedTool) {
      case "workspace_open_file": {
        const controller = this.#controllerWorkspace;
        if (!controller) {
          throw new BridgeError(
            "COMMAND_DENIED",
            "Opening workspace resources requires the active VS Code Remote transport",
          );
        }
        const path = await executor.canonicalPath(requiredPath(args));
        return await controller.requestControllerWorkspace(
          "openWorkspaceResource",
          root.id,
          {
            path,
            ...(observer.threadId ? { threadId: observer.threadId } : {}),
            ...(["line", "column", "endLine", "endColumn"] as const).reduce<
              Record<string, unknown>
            >((params, key) => {
              if (args[key] !== undefined) {
                params[key] = args[key];
              }
              return params;
            }, {}),
          },
        );
      }
      case "workspace_show_diff": {
        const controller = this.#controllerWorkspace;
        if (!controller) {
          throw new BridgeError(
            "COMMAND_DENIED",
            "Showing workspace Diff requires the active VS Code Remote transport",
          );
        }
        if (typeof args.beforeContentBase64 !== "string") {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "beforeContentBase64 must be a string",
          );
        }
        if (typeof args.beforeHash !== "string") {
          throw new BridgeError("PROTOCOL_MISMATCH", "beforeHash must be a string");
        }
        const path = await executor.canonicalPath(requiredPath(args));
        return await controller.requestControllerWorkspace(
          "showWorkspaceDiff",
          root.id,
          {
            beforeContentBase64: args.beforeContentBase64,
            beforeHash: args.beforeHash,
            path,
            ...(observer.threadId ? { threadId: observer.threadId } : {}),
            ...(args.title === undefined ? {} : { title: args.title }),
          },
        );
      }
      case "workspace_write_file": {
        if (typeof args.contentBase64 !== "string") {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "contentBase64 must be a string",
          );
        }
        return await executor.writeFile(
          requiredPath(args),
          args.contentBase64,
          {
            ...(typeof args.expectedHash === "string"
              ? { expectedHash: args.expectedHash }
              : {}),
            idempotencyKey: observer.idempotencyKey,
            signal: observer.signal,
          },
        );
      }
      case "workspace_apply_patch": {
        if (
          !Array.isArray(args.replacements) ||
          !args.replacements.every(
            (entry) =>
              isRecord(entry) &&
              typeof entry.oldText === "string" &&
              typeof entry.newText === "string",
          )
        ) {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "replacements must be text replacement objects",
          );
        }
        if (typeof args.expectedHash !== "string") {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "expectedHash must be a string",
          );
        }
        return await executor.applyPatch(
          requiredPath(args),
          args.replacements as Array<{ oldText: string; newText: string }>,
          {
            expectedHash: args.expectedHash,
            idempotencyKey: observer.idempotencyKey,
            signal: observer.signal,
          },
        );
      }
      case "workspace_create_directory":
        return await executor.createDirectory(requiredPath(args), {
          idempotencyKey: observer.idempotencyKey,
          signal: observer.signal,
        });
      case "workspace_rename_path": {
        if (typeof args.destinationPath !== "string") {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "destinationPath must be a string",
          );
        }
        return await executor.renamePath(
          requiredPath(args),
          args.destinationPath,
          {
            ...(typeof args.expectedHash === "string"
              ? { expectedHash: args.expectedHash }
              : {}),
            idempotencyKey: observer.idempotencyKey,
            signal: observer.signal,
          },
        );
      }
      case "workspace_delete_path":
        return await executor.deletePath(requiredPath(args), {
          ...(typeof args.expectedHash === "string"
            ? { expectedHash: args.expectedHash }
            : {}),
          idempotencyKey: observer.idempotencyKey,
          signal: observer.signal,
        });
      case "workspace_read_file": {
        const limitBytes =
          typeof args.limitBytes === "number" && Number.isInteger(args.limitBytes)
            ? Math.min(args.limitBytes, 5_242_880)
            : undefined;
        return await executor.readFile(requiredPath(args), limitBytes);
      }
      case "workspace_list_directory": {
        const path = requiredPath(args);
        const [canonicalPath, entries] = await Promise.all([
          executor.canonicalPath(path),
          executor.listDirectory(path),
        ]);
        return legacyResult ? entries : { canonicalPath, entries, truncated: false };
      }
      case "workspace_list_tree": {
        const depth =
          typeof args.depth === "number" && Number.isInteger(args.depth)
            ? Math.max(1, Math.min(args.depth, 4))
            : 2;
        const maxEntries =
          typeof args.maxEntries === "number" && Number.isInteger(args.maxEntries)
            ? Math.max(1, Math.min(args.maxEntries, 2_000))
            : 400;
        const path = requiredPath(args);
        const [canonicalPath, listing] = await Promise.all([
          executor.canonicalPath(path),
          executor.listTree(path, depth, maxEntries),
        ]);
        return legacyResult ? listing : { canonicalPath, ...listing };
      }
      case "workspace_search": {
        if (typeof args.query !== "string") {
          throw new BridgeError("PROTOCOL_MISMATCH", "query must be a string");
        }
        if (
          args.paths !== undefined &&
          (!Array.isArray(args.paths) ||
            args.paths.length > 32 ||
            !args.paths.every((entry) => typeof entry === "string"))
        ) {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "paths must contain at most 32 strings",
          );
        }
        const paths =
          Array.isArray(args.paths) && args.paths.length > 0
            ? (args.paths as string[])
            : ["."];
        const maxResults =
          typeof args.maxResults === "number" && Number.isInteger(args.maxResults)
            ? Math.max(1, Math.min(args.maxResults, 1_000))
            : 200;
        const matches = await executor.search(args.query, paths, maxResults);
        return legacyResult
          ? matches
          : {
              matches,
              truncated: matches.length >= maxResults,
            };
      }
      case "workspace_git_status": {
        const result = await executor.gitStatus();
        if (result.exitCode !== 0) {
          throw new BridgeError("COMMAND_DENIED", "Workspace git status failed", {
            exitCode: result.exitCode,
            stderr: result.stderr,
          });
        }
        return result;
      }
      default:
        throw new BridgeError("COMMAND_DENIED", `Unsupported workspace tool: ${tool}`);
    }
  }

  #requestedRoot(
    args: Record<string, unknown>,
    conversationResources: readonly ConversationResourceConfig[] = [],
  ): WorkspaceToolRoot {
    const target = args.target ?? "remote";
    if (target !== "local" && target !== "remote") {
      throw new BridgeError("PROTOCOL_MISMATCH", "target must be local or remote");
    }
    const defaultRoot = this.#config.roots.find(
      (root) => root.target === "remote" && root.role === "primary",
    );
    if (target === "local" && args.rootId === undefined) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "rootId is required when target is local",
      );
    }
    const rootId = args.rootId ?? defaultRoot?.id;
    if (typeof rootId !== "string" || rootId.length === 0) {
      throw new BridgeError("PROTOCOL_MISMATCH", "rootId must be a non-empty string");
    }
    const root =
      target === "remote"
        ? this.#config.roots.find(
            (candidate) => candidate.id === rootId && candidate.target === "remote",
          )
        : this.#config.roots.find(
            (candidate) => candidate.id === rootId && candidate.target === "local",
          ) ??
          conversationResources.find(
            (candidate) => candidate.id === rootId && candidate.target === "local",
          );
    if (!root) {
      throw new BridgeError("COMMAND_DENIED", "The requested workspace root is not configured", {
        rootId,
        target,
      });
    }
    return root;
  }

  #workspaceExecutor(
    root: WorkspaceToolRoot,
    threadId: string | undefined,
  ): WorkspaceExecutor {
    if (root.target === "remote") {
      this.#assertRemotePrimaryRoot(root);
      return this.#executor;
    }
    if (root.role !== "secondary" && root.role !== "conversation") {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Local workspace tools require an authorized local root or conversation resource",
        { rootId: root.id },
      );
    }
    if (!this.#controllerWorkspace) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Local workspace access requires the active VS Code Remote transport",
        { rootId: root.id },
      );
    }
    if (!threadId) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Local workspace access requires an active conversation thread ID",
        { rootId: root.id },
      );
    }
    return new ControllerWorkspaceExecutor(
      root.id,
      this.#controllerWorkspace,
      threadId,
    );
  }

  #assertRemotePrimaryRoot(root: WorkspaceToolRoot): void {
    if (!this.#isRemotePrimaryRoot(root)) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Remote tools can access only the configured remote primary root",
        { rootId: root.id, target: root.target },
      );
    }
  }

  #mutationAuditDetails(args: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof args.path === "string" ? { path: args.path } : {}),
      ...(typeof args.destinationPath === "string"
        ? { destinationPath: args.destinationPath }
        : {}),
      ...(typeof args.expectedHash === "string"
        ? { expectedHash: args.expectedHash }
        : {}),
    };
  }

  #resourceAuditDetails(
    args: Record<string, unknown>,
    data?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...(typeof args.path === "string" ? { path: args.path } : {}),
      ...(typeof args.beforeHash === "string" ? { beforeHash: args.beforeHash } : {}),
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(typeof args.line === "number" ? { line: args.line } : {}),
      ...(data && typeof data.resourceUri === "string"
        ? { resourceUri: data.resourceUri }
        : {}),
      ...(data && typeof data.workspaceUri === "string"
        ? { workspaceUri: data.workspaceUri }
        : {}),
    };
  }

  async #attachWorkspaceResource(
    tool: string,
    data: unknown,
    root: WorkspaceToolRoot,
    threadId: string | undefined,
  ): Promise<unknown> {
    if (!isRecord(data) || typeof data.resourceUri === "string") {
      return data;
    }
    const normalizedTool = normalizeWorkspaceToolName(tool);
    if (
      normalizedTool !== "workspace_read_file" &&
      normalizedTool !== "workspace_write_file" &&
      normalizedTool !== "workspace_apply_patch" &&
      normalizedTool !== "workspace_rename_path"
    ) {
      return data;
    }
    const canonicalPath =
      typeof data.destinationCanonicalPath === "string"
        ? data.destinationCanonicalPath
        : typeof data.canonicalPath === "string"
          ? data.canonicalPath
          : null;
    if (!canonicalPath) {
      return data;
    }
    if (!this.#controllerWorkspace) {
      return data;
    }
    const resource = await this.#controllerWorkspace.requestControllerWorkspace<
      Record<string, unknown>
    >("registerWorkspaceResource", root.id, {
      path: canonicalPath,
      ...(threadId ? { threadId } : {}),
    });
    return typeof resource.resourceUri === "string"
      ? {
          ...data,
          resourceUri: resource.resourceUri,
          ...(typeof resource.workspaceUri === "string"
            ? { workspaceUri: resource.workspaceUri }
            : {}),
        }
      : data;
  }

  #requiredTaskId(args: Record<string, unknown>): string {
    if (
      typeof args.taskId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.taskId)
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "taskId must contain 1 to 64 safe characters",
      );
    }
    return args.taskId;
  }

  #backgroundAuditDetails(
    args: Record<string, unknown>,
    data?: Record<string, unknown>,
  ): Record<string, unknown> {
    const task = data && isRecord(data.task) ? data.task : null;
    const taskId =
      typeof data?.taskId === "string"
        ? data.taskId
        : typeof task?.taskId === "string"
          ? task.taskId
          : typeof args.taskId === "string"
            ? args.taskId
            : undefined;
    const taskStatus =
      typeof data?.status === "string"
        ? data.status
        : typeof task?.status === "string"
          ? task.status
          : undefined;
    return {
      ...(taskId ? { taskId } : {}),
      ...(taskStatus ? { taskStatus } : {}),
      ...(typeof args.cursor === "number" ? { cursor: args.cursor } : {}),
      ...(typeof args.limitBytes === "number"
        ? { limitBytes: args.limitBytes }
        : {}),
    };
  }

  #toolContext(
    root: WorkspaceToolRoot,
    revealLocalPath: boolean,
  ): Omit<ToolRequestContext, "requestId"> {
    return {
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      rootId: root.id,
      rootRole: root.role,
      rootPath:
        root.target === "remote" || revealLocalPath ? root.path : null,
      target: root.target,
    };
  }

  #isRemotePrimaryRoot(root: WorkspaceToolRoot): boolean {
    return (
      root.target === "remote" &&
      root.role === "primary" &&
      root.path === this.#config.workspaceRoot
    );
  }
}
