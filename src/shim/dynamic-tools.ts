import { randomUUID } from "node:crypto";
import { asBridgeError, BridgeError } from "../core/errors.js";
import type { AuditLog } from "../core/audit-log.js";
import type { OpenSshExecutor } from "../core/ssh-executor.js";
import type { BridgeConfig, ToolResult } from "../core/types.js";
import { isRecord, type RpcId } from "./rpc.js";

export const REMOTE_TOOL_NAMES = new Set([
  "remote_read_file",
  "remote_list_directory",
  "remote_search",
  "remote_git_status",
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
      "List direct children only in the configured offline remote Ubuntu workspace.",
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
] as const;

interface DynamicToolCall {
  arguments: unknown;
  callId: string;
  tool: string;
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

  async handle(rpcId: RpcId, rawParams: unknown): Promise<unknown> {
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
      const data = await this.#execute(call.tool, call.arguments);
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

  async #execute(tool: string, rawArguments: unknown): Promise<unknown> {
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
      default:
        throw new BridgeError("COMMAND_DENIED", `Unsupported remote tool: ${tool}`);
    }
  }
}
