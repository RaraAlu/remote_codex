import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { BridgeError } from "../core/errors.js";
import type { BridgeConfig } from "../core/types.js";
import {
  REMOTE_OUTPUT_COMMAND,
  REMOTE_STDIO_MAX_FRAME_BYTES,
  type TransportMessage,
  type TransportRequest,
  type TransportStdioInput,
} from "../core/vscode-transport.js";

export interface VsCodeMcpRelayOptions {
  args: readonly string[];
  config: BridgeConfig;
  connect?: typeof createConnection;
  errorOutput?: Writable;
  executable: string;
  input?: Readable;
  output?: Writable;
}

function writeFrame(socket: Socket, message: TransportRequest | TransportStdioInput): boolean {
  return socket.write(`${JSON.stringify(message)}\n`);
}

export class VsCodeMcpRelay {
  readonly #options: VsCodeMcpRelayOptions;

  constructor(options: VsCodeMcpRelayOptions) {
    this.#options = options;
  }

  async run(): Promise<number> {
    const config = this.#options.config;
    const descriptor = config.vscodeTransport;
    if (config.connectionMode !== "vscode-remote" || !descriptor) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Remote MCP relay requires an active VS Code Remote transport",
      );
    }
    const input = this.#options.input ?? process.stdin;
    const output = this.#options.output ?? process.stdout;
    const errorOutput = this.#options.errorOutput ?? process.stderr;
    const connect = this.#options.connect ?? createConnection;
    const id = `mcp_${randomUUID()}`;
    const request: TransportRequest = {
      hostId: config.host,
      id,
      operation: "stdioStart",
      outputCommand: REMOTE_OUTPUT_COMMAND,
      params: {
        args: [...this.#options.args],
        executable: this.#options.executable,
      },
      policy: {
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      token: descriptor.token,
      workspaceRoot: config.workspaceRoot,
    };

    return await new Promise<number>((resolve, reject) => {
      const socket = connect(descriptor.endpoint);
      const lines = createInterface({ input: socket });
      let ready = false;
      let settled = false;
      let inputEnded = false;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        input.off("data", onInput);
        input.off("end", onInputEnd);
        lines.close();
        socket.destroy();
        callback();
      };
      const sendInput = (message: TransportStdioInput): void => {
        if (!writeFrame(socket, message)) {
          input.pause();
          socket.once("drain", () => input.resume());
        }
      };
      const onInput = (raw: Buffer | string): void => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const frameLimit = Math.max(
          1,
          Math.min(config.maxOutputBytes, REMOTE_STDIO_MAX_FRAME_BYTES),
        );
        for (let offset = 0; offset < chunk.length; offset += frameLimit) {
          sendInput({
            chunk: chunk.subarray(offset, offset + frameLimit).toString("base64"),
            id,
            type: "stdioInput",
          });
        }
      };
      const onInputEnd = (): void => {
        if (inputEnded) {
          return;
        }
        inputEnded = true;
        sendInput({ id, type: "stdioEnd" });
      };

      socket.once("connect", () => writeFrame(socket, request));
      socket.once("error", (error) => {
        finish(() =>
          reject(
            new BridgeError(
              "REMOTE_TRANSPORT_DISCONNECTED",
              `Remote MCP relay connection failed: ${error.message}`,
              undefined,
              { cause: error },
            ),
          ),
        );
      });
      socket.once("end", () => {
        if (!settled) {
          finish(() => resolve(ready ? 1 : 127));
        }
      });
      lines.on("line", (line) => {
        let message: TransportMessage;
        try {
          message = JSON.parse(line) as TransportMessage;
        } catch (error) {
          finish(() =>
            reject(
              new BridgeError("PROTOCOL_MISMATCH", "Remote MCP relay returned invalid JSON", undefined, {
                cause: error,
              }),
            ),
          );
          return;
        }
        if (message.id !== id) {
          finish(() =>
            reject(new BridgeError("PROTOCOL_MISMATCH", "Remote MCP relay id mismatch")),
          );
          return;
        }
        if (message.type === "stdioReady") {
          ready = true;
          input.on("data", onInput);
          input.once("end", onInputEnd);
          if (input.readableEnded) {
            onInputEnd();
          }
          return;
        }
        if (message.type === "stdioOutput") {
          const chunk = Buffer.from(message.chunk, "base64");
          (message.channel === "stdout" ? output : errorOutput).write(chunk);
          return;
        }
        if (message.type === "stdioExit") {
          finish(() => resolve(message.signal ? 128 : (message.exitCode ?? 1)));
          return;
        }
        if (message.type === "response" && message.error) {
          errorOutput.write(`codex-bridge: ${message.error.message}\n`);
          finish(() => resolve(1));
          return;
        }
        if (message.type === "response") {
          finish(() =>
            reject(new BridgeError("PROTOCOL_MISMATCH", "Unexpected remote MCP response")),
          );
        }
      });
    });
  }
}
