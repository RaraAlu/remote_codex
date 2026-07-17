import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AuditLog } from "../core/audit-log.js";
import type { BridgeConfig } from "../core/types.js";
import { OpenSshExecutor, type SpawnProcess } from "../core/ssh-executor.js";
import { DynamicToolRouter, REMOTE_TOOL_NAMES } from "./dynamic-tools.js";
import {
  isRecord,
  isRpcRequest,
  parseRpcLine,
  type RpcMessage,
  type RpcRequest,
} from "./rpc.js";
import { rewriteClientMessage } from "./rewrite.js";

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

export function isUnknownServerRequest(request: RpcRequest): boolean {
  return !KNOWN_SERVER_REQUESTS.has(request.method);
}

export class ShimProxy {
  readonly #options: ShimProxyOptions;
  readonly #audit: AuditLog;
  readonly #executor: OpenSshExecutor | null;
  readonly #router: DynamicToolRouter | null;
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

    if (!isRpcRequest(message)) {
      writeMessage(output, message);
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
        const result = await this.#router.handle(message.id, message.params);
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

    writeMessage(output, message);
  }
}
