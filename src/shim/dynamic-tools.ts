import { randomUUID } from "node:crypto";
import { asBridgeError, BridgeError } from "../core/errors.js";
import type { AuditLog } from "../core/audit-log.js";
import type { OpenSshExecutor } from "../core/ssh-executor.js";
import type { BridgeConfig, ToolResult } from "../core/types.js";
import { isRecord, type RpcId } from "./rpc.js";
import { parseRemoteExecArguments } from "./remote-command.js";

export const REMOTE_TOOL_NAMES = new Set([
  "remote_read_file",
  "remote_list_directory",
  "remote_list_tree",
  "remote_search",
  "remote_git_status",
  "remote_exec",
]);

export const REMOTE_DYNAMIC_TOOLS = [
  {
    type: "function",
    name: "remote_read_file",
    description:
      "Read a file only from the configured offline remote Ubuntu workspace. Returns base64 content and verified remote metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Workspace-relative remote POSIX path." },
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
    name: "remote_list_directory",
    description:
      "List direct children only in the configured offline remote Ubuntu workspace. Use for focused follow-up after remote_list_tree.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Workspace-relative remote directory." },
      },
    },
  },
  {
    type: "function",
    name: "remote_list_tree",
    description:
      "Inspect a bounded remote workspace directory tree in one call. Prefer this before making repeated remote_list_directory calls.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Workspace-relative remote directory." },
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
    name: "remote_search",
    description:
      "Search text with ripgrep only in the configured offline remote Ubuntu workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
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
    name: "remote_git_status",
    description:
      "Run read-only git status in the configured offline remote Ubuntu workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "remote_exec",
    description:
      "Run an approved argv command in the configured remote Ubuntu workspace over SSH. Use for Git, tests, training, diagnostics, and GPU commands. The user must approve every call in the Codex command approval UI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["argv"],
      properties: {
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
  onOutput?: (chunk: string) => void;
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

export class DynamicToolRouter {
  readonly #audit: AuditLog;
  readonly #config: BridgeConfig;
  readonly #executor: OpenSshExecutor;

  constructor(config: BridgeConfig, executor: OpenSshExecutor, audit: AuditLog) {
    this.#config = config;
    this.#executor = executor;
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

    const requestId = call.callId || `req_${randomUUID()}`;
    const startedAt = performance.now();
    await this.#audit.write({
      requestId,
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      workspaceRoot: this.#config.workspaceRoot,
      remoteCwd: this.#config.workspaceRoot,
      operation: call.tool,
      outcome: "started",
      details: { rpcId },
    });

    try {
      const data = await this.#execute(call.tool, call.arguments, observer);
      const truncated = isRecord(data) && data.truncated === true;
      const result: ToolResult<unknown> = {
        ok: true,
        requestId,
        connectionId: this.#executor.connectionId,
        hostId: this.#config.host,
        remoteCwd: this.#config.workspaceRoot,
        data,
        truncated,
        error: null,
      };
      await this.#audit.write({
        requestId,
        connectionId: this.#executor.connectionId,
        hostId: this.#config.host,
        workspaceRoot: this.#config.workspaceRoot,
        remoteCwd: this.#config.workspaceRoot,
        operation: call.tool,
        outcome: "succeeded",
        durationMs: Math.round(performance.now() - startedAt),
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
        connectionId: this.#executor.connectionId,
        hostId: this.#config.host,
        remoteCwd: this.#config.workspaceRoot,
        data: null,
        truncated: bridgeError.code === "OUTPUT_TRUNCATED",
        error: bridgeError.toPayload(),
      };
      await this.#audit.write({
        requestId,
        connectionId: this.#executor.connectionId,
        hostId: this.#config.host,
        workspaceRoot: this.#config.workspaceRoot,
        remoteCwd: this.#config.workspaceRoot,
        operation: call.tool,
        outcome: bridgeError.code === "RESULT_UNKNOWN" ? "unknown" : "failed",
        durationMs: Math.round(performance.now() - startedAt),
        details: { error: bridgeError.toPayload() },
      });
      return {
        success: false,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      };
    }
  }

  async decline(rpcId: RpcId, rawParams: unknown, reason: string): Promise<unknown> {
    const call = parseToolCall(rawParams);
    const requestId = call.callId || `req_${randomUUID()}`;
    const error = new BridgeError("COMMAND_DENIED", reason);
    const result: ToolResult<never> = {
      ok: false,
      requestId,
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      remoteCwd: this.#config.workspaceRoot,
      data: null,
      truncated: false,
      error: error.toPayload(),
    };
    await this.#audit.write({
      requestId,
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      workspaceRoot: this.#config.workspaceRoot,
      remoteCwd: this.#config.workspaceRoot,
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
    rawArguments: unknown,
    observer: DynamicToolObserver,
  ): Promise<unknown> {
    const args = argumentObject(rawArguments);
    switch (tool) {
      case "remote_read_file": {
        const limitBytes =
          typeof args.limitBytes === "number" && Number.isInteger(args.limitBytes)
            ? Math.min(args.limitBytes, 5_242_880)
            : undefined;
        return await this.#executor.readFile(requiredPath(args), limitBytes);
      }
      case "remote_list_directory":
        return await this.#executor.listDirectory(requiredPath(args));
      case "remote_list_tree": {
        const depth =
          typeof args.depth === "number" && Number.isInteger(args.depth)
            ? Math.max(1, Math.min(args.depth, 4))
            : 2;
        const maxEntries =
          typeof args.maxEntries === "number" && Number.isInteger(args.maxEntries)
            ? Math.max(1, Math.min(args.maxEntries, 2_000))
            : 400;
        return await this.#executor.listTree(requiredPath(args), depth, maxEntries);
      }
      case "remote_search": {
        if (typeof args.query !== "string") {
          throw new BridgeError("PROTOCOL_MISMATCH", "query must be a string");
        }
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((entry): entry is string => typeof entry === "string")
          : ["."];
        const maxResults =
          typeof args.maxResults === "number" && Number.isInteger(args.maxResults)
            ? Math.max(1, Math.min(args.maxResults, 1_000))
            : 200;
        return await this.#executor.search(args.query, paths, maxResults);
      }
      case "remote_git_status": {
        const result = await this.#executor.execute(["git", "status", "--short", "--branch"]);
        if (result.exitCode !== 0) {
          throw new BridgeError("COMMAND_DENIED", "Remote git status failed", {
            exitCode: result.exitCode,
            stderr: result.stderr,
          });
        }
        return result;
      }
      case "remote_exec": {
        const request = parseRemoteExecArguments(args);
        return await this.#executor.execute(request.argv, {
          cwd: request.cwd,
          env: request.env,
          timeoutMs: request.timeoutMs,
          sideEffect: true,
          onStdout: observer.onOutput,
          onStderr: observer.onOutput,
        });
      }
      default:
        throw new BridgeError("COMMAND_DENIED", `Unsupported remote tool: ${tool}`);
    }
  }
}
