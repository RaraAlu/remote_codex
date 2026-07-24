import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AuditLog } from "../core/audit-log.js";
import { normalizeRemotePath } from "../core/path-policy.js";
import type { BridgeConfig } from "../core/types.js";
import { OpenSshExecutor, type SpawnProcess } from "../core/ssh-executor.js";
import { VsCodeRemoteExecutor } from "../core/vscode-remote-executor.js";
import {
  DynamicToolRouter,
  REMOTE_BACKGROUND_TOOL_NAMES,
  REMOTE_TOOL_NAMES,
  WORKSPACE_MUTATION_TOOL_NAMES,
} from "./dynamic-tools.js";
import {
  isBlockedLocalClientMethod,
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

function isRemoteCommandStartToolCall(request: RpcRequest): boolean {
  return (
    isRemoteExecToolCall(request) ||
    (request.method === "item/tool/call" &&
      isRecord(request.params) &&
      request.params.tool === "remote_background_start")
  );
}

function isWorkspaceMutationToolCall(request: RpcRequest): boolean {
  return (
    request.method === "item/tool/call" &&
    isRecord(request.params) &&
    typeof request.params.tool === "string" &&
    WORKSPACE_MUTATION_TOOL_NAMES.has(request.params.tool)
  );
}

export function remoteToolIdempotencyKey(request: RpcRequest): string {
  if (
    !isRecord(request.params) ||
    typeof request.params.threadId !== "string" ||
    typeof request.params.turnId !== "string" ||
    typeof request.params.callId !== "string"
  ) {
    throw new TypeError("Remote tool call is missing thread, turn, or item identity");
  }
  return createHash("sha256")
    .update(
      [request.params.threadId, request.params.turnId, request.params.callId].join(
        "\0",
      ),
    )
    .digest("hex");
}

interface RemoteExecContext {
  callId: string;
  command: string;
  cwd: string;
  threadId: string;
  turnId: string;
}

interface WorkspaceMutationContext extends RemoteExecContext {
  destinationPath?: string;
  path: string;
  requiresApproval: boolean;
  rootId: string;
  rootRole: "primary" | "secondary";
  target: "local" | "remote";
  tool: string;
}

interface PendingApproval {
  settle: (approved: boolean) => void;
}

interface CoordinatedRemoteToolCall {
  controller: AbortController;
  fingerprint: string;
  operation: (signal: AbortSignal) => Promise<unknown>;
  priority: number;
  result: Promise<unknown>;
  settled: boolean;
  started: boolean;
  threadId: string;
  timer?: NodeJS.Timeout;
  turnId: string;
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
    operation: (signal: AbortSignal) => Promise<unknown>,
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
      controller: new AbortController(),
      fingerprint,
      operation,
      priority,
      result,
      settled: false,
      started: false,
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      resolve: resolveResult,
      reject: rejectResult,
    };
    this.#calls.set(key, coordinated);
    void result.then(
      () => {
        coordinated.settled = true;
        this.#scheduleDelete(key, coordinated);
      },
      () => {
        coordinated.settled = true;
        this.#scheduleDelete(key, coordinated);
      },
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

  cancelTurn(threadId: string, turnId: string): number {
    let cancelled = 0;
    for (const call of this.#calls.values()) {
      if (
        call.threadId !== threadId ||
        call.turnId !== turnId ||
        call.settled ||
        call.controller.signal.aborted
      ) {
        continue;
      }
      call.controller.abort();
      cancelled += 1;
      if (!call.started) {
        this.#start(call);
      }
    }
    return cancelled;
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
      .then(() => call.operation(call.controller.signal))
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
    if (
      this.#options.config &&
      isRpcRequest(message) &&
      message.method === "turn/interrupt" &&
      isRecord(message.params) &&
      typeof message.params.threadId === "string" &&
      typeof message.params.turnId === "string"
    ) {
      const cancelledCalls = this.#remoteToolCalls.cancelTurn(
        message.params.threadId,
        message.params.turnId,
      );
      await this.#audit.write({
        hostId: this.#options.config.host,
        workspaceRoot: this.#options.config.workspaceRoot,
        operation: "remote_tool.cancel",
        outcome: cancelledCalls > 0 ? "cancelled" : "succeeded",
        details: {
          cancelledCalls,
          threadId: message.params.threadId,
          turnId: message.params.turnId,
        },
      });
    }
    if (this.#options.config && isBlockedLocalClientMessage(message)) {
      await this.#audit.write({
        hostId: this.#options.config.host,
        workspaceRoot: this.#options.config.workspaceRoot,
        operation: "local_core_request.blocked",
        outcome: "failed",
        details: {
          knownMethod: isBlockedLocalClientMethod(message.method),
          method: message.method,
        },
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
          async (signal) => {
            let execContext: RemoteExecContext | null = null;
            const idempotencyKey = remoteToolIdempotencyKey(message);
            if (isRemoteCommandStartToolCall(message)) {
              execContext = this.#remoteExecContext(message);
              if (signal.aborted) {
                return await this.#router!.handle(message.id, message.params, {
                  idempotencyKey,
                  signal,
                });
              }
              const requiresApproval = this.#remoteApprovalPolicies.requiresApproval(
                execContext.threadId,
              );
              const approvalOperation =
                isRecord(message.params) &&
                message.params.tool === "remote_background_start"
                  ? "remote_background_start.approval"
                  : "remote_exec.approval";
              const approved = requiresApproval
                ? await this.#requestRemoteCommandApproval(
                    execContext,
                    writeClient,
                    signal,
                  )
                : true;
              if (requiresApproval) {
                await this.#audit.write({
                  requestId: execContext.callId,
                  connectionId: this.#executor?.connectionId,
                  hostId: this.#options.config?.host,
                  workspaceRoot: this.#options.config?.workspaceRoot,
                  remoteCwd: execContext.cwd,
                  operation: approvalOperation,
                  outcome: approved ? "succeeded" : "cancelled",
                  details: {
                    automatic: false,
                    decision: approved
                      ? "accept"
                      : signal.aborted
                        ? "cancelled"
                        : "decline",
                  },
                });
              }
              if (
                requiresApproval &&
                !approved
              ) {
                if (signal.aborted) {
                  return await this.#router!.handle(message.id, message.params, {
                    idempotencyKey,
                    signal,
                  });
                }
                return await this.#router!.decline(
                  message.id,
                  message.params,
                  "Remote command execution was declined by the user",
                );
              }
              if (!requiresApproval) {
                await this.#audit.write({
                  requestId: execContext.callId,
                  hostId: this.#options.config?.host,
                  workspaceRoot: this.#options.config?.workspaceRoot,
                  remoteCwd: execContext.cwd,
                  operation: approvalOperation,
                  outcome: "succeeded",
                  details: {
                    automatic: true,
                    permissionMode: "full-access",
                  },
                });
              }
            } else if (isWorkspaceMutationToolCall(message)) {
              const context = this.#workspaceMutationContext(message);
              if (signal.aborted) {
                return await this.#router!.handle(message.id, message.params, {
                  idempotencyKey,
                  signal,
                });
              }
              const permissionRequiresApproval =
                this.#remoteApprovalPolicies.requiresApproval(context.threadId);
              if (
                context.requiresApproval &&
                permissionRequiresApproval &&
                !(await this.#requestWorkspaceMutationApproval(
                  context,
                  writeClient,
                  signal,
                ))
              ) {
                if (signal.aborted) {
                  return await this.#router!.handle(message.id, message.params, {
                    idempotencyKey,
                    signal,
                  });
                }
                return await this.#router!.decline(
                  message.id,
                  message.params,
                  "Workspace mutation was declined by the user",
                );
              }
              if (!context.requiresApproval || !permissionRequiresApproval) {
                await this.#auditWorkspaceMutationApproval(context, {
                  automatic: true,
                  permissionMode: permissionRequiresApproval
                    ? "bounded-create"
                    : "full-access",
                });
              }
            }

            return await this.#router!.handle(message.id, message.params, {
              idempotencyKey,
              signal,
              onOutput: isRemoteExecToolCall(message) && execContext
                ? (delta) => {
                    writeClient({
                      method: "item/commandExecution/outputDelta",
                      params: {
                        delta,
                        itemId: execContext.callId,
                        threadId: execContext.threadId,
                        turnId: execContext.turnId,
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
    const maxTimeoutMs =
      params.tool === "remote_background_start" &&
      REMOTE_BACKGROUND_TOOL_NAMES.has(params.tool)
        ? 24 * 60 * 60_000
        : 60 * 60_000;
    const remote = parseRemoteExecArguments(params.arguments, maxTimeoutMs);
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

  #workspaceMutationContext(request: RpcRequest): WorkspaceMutationContext {
    const config = this.#options.config;
    if (!config || !isRecord(request.params)) {
      throw new TypeError("Workspace mutation approval requires Bridge configuration");
    }
    const params = request.params;
    if (
      typeof params.callId !== "string" ||
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string" ||
      typeof params.tool !== "string" ||
      !WORKSPACE_MUTATION_TOOL_NAMES.has(params.tool) ||
      !isRecord(params.arguments)
    ) {
      throw new TypeError(
        "Workspace mutation call is missing identity, tool, or arguments",
      );
    }
    const args = params.arguments;
    if (typeof args.path !== "string") {
      throw new TypeError("Workspace mutation path must be a string");
    }
    const target = args.target ?? "remote";
    if (target !== "local" && target !== "remote") {
      throw new TypeError("Workspace mutation target must be local or remote");
    }
    const defaultRoot = config.roots.find(
      (root) => root.target === "remote" && root.role === "primary",
    );
    const rootId = args.rootId ?? defaultRoot?.id;
    if (typeof rootId !== "string") {
      throw new TypeError("Workspace mutation rootId is missing");
    }
    const root = config.roots.find(
      (candidate) => candidate.id === rootId && candidate.target === target,
    );
    if (!root) {
      throw new TypeError("Workspace mutation root is not configured");
    }
    const normalizePath = (value: string): string => {
      if (target === "remote") {
        return normalizeRemotePath(root.path, value).absolutePath;
      }
      const absolutePath = resolve(root.path, value || ".");
      const child = relative(root.path, absolutePath);
      if (
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child)
      ) {
        throw new TypeError("Workspace mutation path escapes the configured root");
      }
      return absolutePath;
    };
    const path = normalizePath(args.path);
    const destinationPath =
      typeof args.destinationPath === "string"
        ? normalizePath(args.destinationPath)
        : undefined;
    const command = [
      params.tool,
      `${target}:${root.id}`,
      path,
      ...(destinationPath ? ["->", destinationPath] : []),
    ].join(" ");
    return {
      callId: params.callId,
      command,
      cwd: root.path,
      ...(destinationPath ? { destinationPath } : {}),
      path,
      requiresApproval:
        params.tool === "workspace_apply_patch" ||
        params.tool === "workspace_rename_path" ||
        params.tool === "workspace_delete_path" ||
        (params.tool === "workspace_write_file" &&
          typeof args.expectedHash === "string"),
      rootId: root.id,
      rootRole: root.role,
      target,
      threadId: params.threadId,
      tool: params.tool,
      turnId: params.turnId,
    };
  }

  async #requestWorkspaceMutationApproval(
    context: WorkspaceMutationContext,
    writeClient: RpcMessageWriter,
    signal: AbortSignal,
  ): Promise<boolean> {
    const approved = await this.#requestRemoteCommandApproval(
      context,
      writeClient,
      signal,
      `在已授权的 ${context.target} 工作区执行 ${context.tool}`,
    );
    await this.#auditWorkspaceMutationApproval(context, {
      automatic: false,
      decision: approved ? "accept" : signal.aborted ? "cancelled" : "decline",
    });
    return approved;
  }

  async #auditWorkspaceMutationApproval(
    context: WorkspaceMutationContext,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.#audit.write({
      requestId: context.callId,
      connectionId: this.#executor?.connectionId,
      hostId: this.#options.config?.host,
      workspaceRoot: this.#options.config?.workspaceRoot,
      ...(context.target === "remote" ? { remoteCwd: context.cwd } : {}),
      rootId: context.rootId,
      rootRole: context.rootRole,
      rootPath: context.cwd,
      target: context.target,
      operation: "workspace_mutation.approval",
      outcome:
        details.decision === "decline" || details.decision === "cancelled"
          ? "cancelled"
          : "succeeded",
      details: {
        ...details,
        tool: context.tool,
        path: context.path,
        ...(context.destinationPath
          ? { destinationPath: context.destinationPath }
          : {}),
      },
    });
  }

  async #requestRemoteCommandApproval(
    context: RemoteExecContext,
    writeClient: RpcMessageWriter,
    signal: AbortSignal,
    reason?: string,
  ): Promise<boolean> {
    const config = this.#options.config;
    if (!config) {
      throw new TypeError("Remote command approval requires Bridge configuration");
    }
    if (signal.aborted) {
      return false;
    }
    const approvalId = `codex-bridge-approval:${randomUUID()}`;
    const approved = new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout;
      const abort = (): void => settle(false);
      const settle = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.#pendingApprovals.delete(approvalId);
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      timeout = setTimeout(() => settle(false), 10 * 60_000);
      timeout.unref();
      this.#pendingApprovals.set(approvalId, { settle });
      signal.addEventListener("abort", abort, { once: true });
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
        reason:
          reason ?? `通过 SSH 在远程主机 ${config.host} 上执行此命令`,
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
    const decision =
      isRecord(response.result) && typeof response.result.decision === "string"
        ? response.result.decision
        : "";
    pending.settle(decision === "accept");
    return true;
  }

  #cancelApprovals(): void {
    for (const pending of this.#pendingApprovals.values()) {
      pending.settle(false);
    }
    this.#pendingApprovals.clear();
  }

  closeSession(): void {
    this.#cancelApprovals();
    this.#executor?.close();
  }
}
