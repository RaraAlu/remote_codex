import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AuditLog } from "../core/audit-log.js";
import { normalizeRemotePath } from "../core/path-policy.js";
import type { BridgeConfig } from "../core/types.js";
import { OpenSshExecutor, type SpawnProcess } from "../core/ssh-executor.js";
import { DynamicToolRouter, REMOTE_TOOL_NAMES } from "./dynamic-tools.js";
import { formatRemoteExecRequest, parseRemoteExecArguments } from "./remote-command.js";
import { RemoteApprovalPolicyTracker } from "./remote-approval-policy.js";
import {
  isRecord,
  isRpcRequest,
  isRpcResponse,
  parseRpcLine,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./rpc.js";
import { rewriteClientMessage } from "./rewrite.js";
import { projectServerMessage } from "./native-tool-presentation.js";

export const KNOWN_SERVER_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
]);

export interface ShimProxyOptions {
  appServerArgs: readonly string[];
  auditPath: string;
  codexExecutable: string;
  config: BridgeConfig | null;
  controlDir: string;
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  spawnCodex?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  spawnSsh?: SpawnProcess;
}

function writeMessage(stream: Writable, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function isRemoteToolCall(request: RpcRequest): boolean {
  return (
    request.method === "item/tool/call" &&
    isRecord(request.params) &&
    typeof request.params.tool === "string" &&
    REMOTE_TOOL_NAMES.has(request.params.tool)
  );
}

function isRemoteExecToolCall(request: RpcRequest): boolean {
  return (
    request.method === "item/tool/call" &&
    isRecord(request.params) &&
    request.params.tool === "remote_exec"
  );
}

interface RemoteExecContext {
  callId: string;
  command: string;
  cwd: string;
  threadId: string;
  turnId: string;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

export function isUnknownServerRequest(request: RpcRequest): boolean {
  return !KNOWN_SERVER_REQUESTS.has(request.method);
}

export class ShimProxy {
  readonly #options: ShimProxyOptions;
  readonly #audit: AuditLog;
  readonly #executor: OpenSshExecutor | null;
  readonly #router: DynamicToolRouter | null;
  readonly #remoteApprovalPolicies = new RemoteApprovalPolicyTracker();
  readonly #pendingApprovals = new Map<RpcId, PendingApproval>();
  #child: ChildProcessWithoutNullStreams | null = null;

  constructor(options: ShimProxyOptions) {
    this.#options = options;
    this.#audit = new AuditLog(options.auditPath);
    this.#executor = options.config
      ? new OpenSshExecutor(options.config, options.spawnSsh)
      : null;
    this.#router =
      options.config && this.#executor
        ? new DynamicToolRouter(options.config, this.#executor, this.#audit)
        : null;
  }

  async run(): Promise<number> {
    const input = this.#options.input ?? process.stdin;
    const output = this.#options.output ?? process.stdout;
    const errorOutput = this.#options.errorOutput ?? process.stderr;
    const spawnCodex = this.#options.spawnCodex ?? spawn;
    const child = spawnCodex(
      this.#options.codexExecutable,
      [...this.#options.appServerArgs],
      {
        cwd: this.#options.controlDir,
        env: process.env,
        stdio: "pipe",
      },
    );
    this.#child = child;

    child.stderr.pipe(errorOutput, { end: false });
    const clientLines = createInterface({ input });
    const serverLines = createInterface({ input: child.stdout });

    clientLines.on("line", (line) => {
      try {
        const message = parseRpcLine(line);
        this.#remoteApprovalPolicies.observeClientMessage(message);
        if (isRpcResponse(message) && this.#resolveApproval(message)) {
          return;
        }
        const rewritten = rewriteClientMessage(
          message,
          this.#options.config,
          this.#options.controlDir,
        );
        writeMessage(child.stdin, rewritten);
      } catch (error) {
        errorOutput.write(`codex-bridge: invalid client JSON-RPC: ${String(error)}\n`);
      }
    });
    clientLines.on("close", () => child.stdin.end());

    serverLines.on("line", (line) => {
      void this.#handleServerLine(line, child.stdin, output, errorOutput).catch((error) => {
        errorOutput.write(`codex-bridge: server request handling failed: ${String(error)}\n`);
      });
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal);
      this.#executor?.close();
    };
    const onSigInt = (): void => forwardSignal("SIGINT");
    const onSigTerm = (): void => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);

    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        process.removeListener("SIGINT", onSigInt);
        process.removeListener("SIGTERM", onSigTerm);
        clientLines.close();
        serverLines.close();
        this.#cancelApprovals();
        this.#executor?.close();
        if (signal) {
          resolve(128);
        } else {
          resolve(code ?? 1);
        }
      });
    });
  }

  async #handleServerLine(
    line: string,
    childInput: Writable,
    output: Writable,
    errorOutput: Writable,
  ): Promise<void> {
    let message: RpcMessage;
    try {
      message = parseRpcLine(line);
    } catch (error) {
      errorOutput.write(`codex-bridge: invalid server JSON-RPC: ${String(error)}\n`);
      return;
    }
    this.#remoteApprovalPolicies.observeServerMessage(message);

    if (!isRpcRequest(message)) {
      writeMessage(output, projectServerMessage(message, this.#options.config));
      return;
    }

    if (isRemoteToolCall(message)) {
      if (!this.#router) {
        writeMessage(childInput, {
          id: message.id,
          error: {
            code: -32002,
            message: "Bridge is not configured; remote tool call refused",
          },
        });
        return;
      }
      try {
        let context: RemoteExecContext | null = null;
        if (isRemoteExecToolCall(message)) {
          context = this.#remoteExecContext(message);
          const requiresApproval = this.#remoteApprovalPolicies.requiresApproval(
            context.threadId,
          );
          if (
            requiresApproval &&
            !(await this.#requestRemoteCommandApproval(context, output))
          ) {
            const result = await this.#router.decline(
              message.id,
              message.params,
              "Remote command execution was declined by the user",
            );
            writeMessage(childInput, { id: message.id, result });
            return;
          }
          if (!requiresApproval) {
            await this.#audit.write({
              requestId: context.callId,
              hostId: this.#options.config?.host,
              workspaceRoot: this.#options.config?.workspaceRoot,
              remoteCwd: context.cwd,
              operation: "remote_exec.approval",
              outcome: "succeeded",
              details: {
                automatic: true,
                permissionMode: "full-access",
              },
            });
          }
        }
        const result = await this.#router.handle(message.id, message.params, {
          onOutput: context
            ? (delta) => {
                writeMessage(output, {
                  method: "item/commandExecution/outputDelta",
                  params: {
                    delta,
                    itemId: context.callId,
                    threadId: context.threadId,
                    turnId: context.turnId,
                  },
                });
              }
            : undefined,
        });
        writeMessage(childInput, { id: message.id, result });
      } catch (error) {
        writeMessage(childInput, {
          id: message.id,
          error: {
            code: -32602,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (isUnknownServerRequest(message)) {
      await this.#audit.write({
        operation: "protocol.unknown_server_request",
        outcome: "failed",
        details: { method: message.method },
      });
      writeMessage(childInput, {
        id: message.id,
        error: {
          code: -32601,
          message: `Codex Bridge refused unknown server request: ${message.method}`,
        },
      });
      return;
    }

    writeMessage(output, projectServerMessage(message, this.#options.config));
  }

  #remoteExecContext(request: RpcRequest): RemoteExecContext {
    const config = this.#options.config;
    if (!config || !isRecord(request.params)) {
      throw new TypeError("Remote command approval requires Bridge configuration");
    }
    const params = request.params;
    if (
      typeof params.callId !== "string" ||
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string"
    ) {
      throw new TypeError("Remote command call is missing thread, turn, or item identity");
    }
    const remote = parseRemoteExecArguments(params.arguments);
    const context: RemoteExecContext = {
      callId: params.callId,
      command: formatRemoteExecRequest(remote),
      cwd: normalizeRemotePath(
        config.workspaceRoot,
        remote.cwd ?? config.workspaceRoot,
      ).absolutePath,
      threadId: params.threadId,
      turnId: params.turnId,
    };
    return context;
  }

  async #requestRemoteCommandApproval(
    context: RemoteExecContext,
    output: Writable,
  ): Promise<boolean> {
    const config = this.#options.config;
    if (!config) {
      throw new TypeError("Remote command approval requires Bridge configuration");
    }
    const approvalId = `codex-bridge-approval:${randomUUID()}`;
    const approved = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.#pendingApprovals.delete(approvalId);
        resolve(false);
      }, 10 * 60_000);
      timeout.unref();
      this.#pendingApprovals.set(approvalId, { resolve, timeout });
    });
    writeMessage(output, {
      id: approvalId,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: context.callId,
        threadId: context.threadId,
        turnId: context.turnId,
        startedAtMs: Date.now(),
        command: context.command,
        commandActions: [{ type: "unknown", command: context.command }],
        cwd: context.cwd,
        reason: `通过 SSH 在远程主机 ${config.host} 上执行此命令`,
        availableDecisions: ["accept", "decline"],
      },
    });
    return await approved;
  }

  #resolveApproval(response: RpcResponse): boolean {
    const pending = this.#pendingApprovals.get(response.id);
    if (!pending) {
      return false;
    }
    this.#pendingApprovals.delete(response.id);
    clearTimeout(pending.timeout);
    const decision =
      isRecord(response.result) && typeof response.result.decision === "string"
        ? response.result.decision
        : "";
    pending.resolve(decision === "accept");
    return true;
  }

  #cancelApprovals(): void {
    for (const pending of this.#pendingApprovals.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.#pendingApprovals.clear();
  }
}
