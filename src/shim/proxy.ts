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
import { VsCodeRemoteExecutor } from "../core/vscode-remote-executor.js";
import { DynamicToolRouter, REMOTE_TOOL_NAMES } from "./dynamic-tools.js";
import {
  isBlockedLocalClientMessage,
  isBlockedLocalServerApproval,
} from "./local-core-policy.js";
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
  approvalPolicies?: RemoteApprovalPolicyTracker;
  remoteToolCalls?: RemoteToolCallCoordinator;
  remoteToolPriority?: number;
  observeApprovalPolicy?: boolean;
  rewriteClientMessages?: boolean;
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

export type RpcMessageWriter = (message: unknown) => void;

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

interface CoordinatedRemoteToolCall {
  fingerprint: string;
  operation: () => Promise<unknown>;
  priority: number;
  result: Promise<unknown>;
  started: boolean;
  timer?: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

const REMOTE_TOOL_PRIMARY_GRACE_MS = 25;
const REMOTE_TOOL_RESULT_RETENTION_MS = 1_000;

export class RemoteToolCallCoordinator {
  readonly #calls = new Map<string, CoordinatedRemoteToolCall>();

  async run(
    request: RpcRequest,
    priority: number,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    if (
      !isRecord(request.params) ||
      typeof request.params.threadId !== "string" ||
      typeof request.params.turnId !== "string" ||
      typeof request.params.callId !== "string"
    ) {
      throw new TypeError("Remote tool call is missing thread, turn, or item identity");
    }
    const key = [
      request.params.threadId,
      request.params.turnId,
      request.params.callId,
    ].join("\u0000");
    const fingerprint = JSON.stringify(request.params);
    const existing = this.#calls.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TypeError("Remote tool call identity was reused with different parameters");
      }
      if (!existing.started && priority < existing.priority) {
        existing.priority = priority;
        existing.operation = operation;
        this.#start(existing);
      }
      return await existing.result;
    }

    let resolveResult: (result: unknown) => void = () => undefined;
    let rejectResult: (error: unknown) => void = () => undefined;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const coordinated: CoordinatedRemoteToolCall = {
      fingerprint,
      operation,
      priority,
      result,
      started: false,
      resolve: resolveResult,
      reject: rejectResult,
    };
    this.#calls.set(key, coordinated);
    void result.then(
      () => this.#scheduleDelete(key, coordinated),
      () => this.#scheduleDelete(key, coordinated),
    );
    if (priority <= 0) {
      this.#start(coordinated);
    } else {
      coordinated.timer = setTimeout(
        () => this.#start(coordinated),
        REMOTE_TOOL_PRIMARY_GRACE_MS,
      );
      coordinated.timer.unref();
    }
    return await result;
  }

  #start(call: CoordinatedRemoteToolCall): void {
    if (call.started) {
      return;
    }
    call.started = true;
    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = undefined;
    }
    void Promise.resolve()
      .then(call.operation)
      .then(call.resolve, call.reject);
  }

  #scheduleDelete(key: string, call: CoordinatedRemoteToolCall): void {
    const timer = setTimeout(() => {
      if (this.#calls.get(key) === call) {
        this.#calls.delete(key);
      }
    }, REMOTE_TOOL_RESULT_RETENTION_MS);
    timer.unref();
  }
}

export function isUnknownServerRequest(request: RpcRequest): boolean {
  return !KNOWN_SERVER_REQUESTS.has(request.method);
}

export class ShimProxy {
  readonly #options: ShimProxyOptions;
  readonly #audit: AuditLog;
  readonly #executor: OpenSshExecutor | null;
  readonly #router: DynamicToolRouter | null;
  readonly #remoteApprovalPolicies: RemoteApprovalPolicyTracker;
  readonly #remoteToolCalls: RemoteToolCallCoordinator;
  readonly #pendingApprovals = new Map<RpcId, PendingApproval>();
  #child: ChildProcessWithoutNullStreams | null = null;

  constructor(options: ShimProxyOptions) {
    this.#options = options;
    this.#audit = new AuditLog(options.auditPath);
    this.#remoteApprovalPolicies =
      options.approvalPolicies ?? new RemoteApprovalPolicyTracker();
    this.#remoteToolCalls = options.remoteToolCalls ?? new RemoteToolCallCoordinator();
    this.#executor = options.config
      ? options.config.connectionMode === "vscode-remote"
        ? new VsCodeRemoteExecutor(options.config)
        : new OpenSshExecutor(options.config, options.spawnSsh)
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
    let clientQueue = Promise.resolve();

    clientLines.on("line", (line) => {
      clientQueue = clientQueue
        .then(() =>
          this.handleClientMessage(
            parseRpcLine(line),
            (message) => writeMessage(child.stdin, message),
            (message) => writeMessage(output, message),
          ),
        )
        .catch((error) => {
          errorOutput.write(`codex-bridge: invalid client JSON-RPC: ${String(error)}\n`);
        });
    });
    clientLines.on("close", () => {
      void clientQueue.finally(() => child.stdin.end());
    });

    serverLines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = parseRpcLine(line);
      } catch (error) {
        errorOutput.write(`codex-bridge: invalid server JSON-RPC: ${String(error)}\n`);
        return;
      }
      void this.handleServerMessage(
        message,
        (message) => writeMessage(child.stdin, message),
        (message) => writeMessage(output, message),
      ).catch((error) => {
        errorOutput.write(`codex-bridge: server request handling failed: ${String(error)}\n`);
      });
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal);
      this.closeSession();
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
        this.closeSession();
        if (signal) {
          resolve(128);
        } else {
          resolve(code ?? 1);
        }
      });
    });
  }

  async handleClientMessage(
    message: RpcMessage,
    writeServer: RpcMessageWriter,
    writeClient: RpcMessageWriter,
  ): Promise<void> {
    if (this.#options.observeApprovalPolicy !== false) {
      this.#remoteApprovalPolicies.observeClientMessage(message);
    }
    if (isRpcResponse(message) && this.#resolveApproval(message)) {
      return;
    }
    if (this.#options.config && isBlockedLocalClientMessage(message)) {
      await this.#audit.write({
        hostId: this.#options.config.host,
        workspaceRoot: this.#options.config.workspaceRoot,
        operation: "local_core_request.blocked",
        outcome: "failed",
        details: { method: message.method },
      });
      if (isRpcRequest(message)) {
        writeClient({
          id: message.id,
          error: {
            code: -32003,
            message: `Codex Remote Bridge blocked local Core request: ${message.method}`,
          },
        });
      }
      return;
    }
    const rewritten =
      this.#options.rewriteClientMessages === false
        ? message
        : rewriteClientMessage(
            message,
            this.#options.config,
            this.#options.controlDir,
          );
    writeServer(rewritten);
  }

  async handleServerMessage(
    message: RpcMessage,
    writeServer: RpcMessageWriter,
    writeClient: RpcMessageWriter,
  ): Promise<void> {
    this.#remoteApprovalPolicies.observeServerMessage(message);

    if (!isRpcRequest(message)) {
      writeClient(projectServerMessage(message, this.#options.config));
      return;
    }

    if (this.#options.config && isBlockedLocalServerApproval(message)) {
      await this.#audit.write({
        hostId: this.#options.config.host,
        workspaceRoot: this.#options.config.workspaceRoot,
        operation: "local_core_approval.blocked",
        outcome: "failed",
        details: { method: message.method },
      });
      writeServer({
        id: message.id,
        error: {
          code: -32003,
          message: `Codex Remote Bridge blocked local Core approval: ${message.method}`,
        },
      });
      return;
    }

    if (isRemoteToolCall(message)) {
      if (!this.#router) {
        writeServer({
          id: message.id,
          error: {
            code: -32002,
            message: "Bridge is not configured; remote tool call refused",
          },
        });
        return;
      }
      try {
        const result = await this.#remoteToolCalls.run(
          message,
          this.#options.remoteToolPriority ?? 0,
          async () => {
            let context: RemoteExecContext | null = null;
            if (isRemoteExecToolCall(message)) {
              context = this.#remoteExecContext(message);
              const requiresApproval = this.#remoteApprovalPolicies.requiresApproval(
                context.threadId,
              );
              if (
                requiresApproval &&
                !(await this.#requestRemoteCommandApproval(context, writeClient))
              ) {
                return await this.#router!.decline(
                  message.id,
                  message.params,
                  "Remote command execution was declined by the user",
                );
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

            return await this.#router!.handle(message.id, message.params, {
              onOutput: context
                ? (delta) => {
                    writeClient({
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
          },
        );
        writeServer({ id: message.id, result });
      } catch (error) {
        writeServer({
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
      writeServer({
        id: message.id,
        error: {
          code: -32601,
          message: `Codex Bridge refused unknown server request: ${message.method}`,
        },
      });
      return;
    }

    writeClient(projectServerMessage(message, this.#options.config));
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
    writeClient: RpcMessageWriter,
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
    writeClient({
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

  closeSession(): void {
    this.#cancelApprovals();
    this.#executor?.close();
  }
}
