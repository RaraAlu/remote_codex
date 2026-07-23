import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { realpath } from "node:fs/promises";
import { BridgeError } from "../core/errors.js";
import { remoteProcessEnvironment } from "../core/local-process-executor.js";
import { resolveRemoteMcpLaunch } from "../core/remote-mcp-adapters.js";
import {
  assertRemoteMcpLaunch,
  resolveRemoteMcpExecutable,
} from "../core/remote-mcp-policy.js";
import type { RemoteStdioEvent } from "../core/vscode-transport.js";

export type SpawnStdioProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface StdioSession {
  child: ChildProcessWithoutNullStreams;
  outputQueue: Promise<void>;
}

export interface StartStdioRequest {
  adapterId?: string | null;
  args: string[];
  executable: string;
  id: string;
  maxFrameBytes: number;
  serverName?: string | null;
  workspaceRoot: string;
}

export class RemoteStdioSessions {
  readonly #emit: (event: RemoteStdioEvent) => Promise<void>;
  readonly #sessions = new Map<string, StdioSession>();
  readonly #spawn: SpawnStdioProcess;
  readonly #resolveExecutable: (executable: string) => Promise<string | null>;

  constructor(
    emit: (event: RemoteStdioEvent) => Promise<void>,
    spawnProcess: SpawnStdioProcess = spawn,
    resolveExecutable: (executable: string) => Promise<string | null> =
      resolveRemoteMcpExecutable,
  ) {
    this.#emit = emit;
    this.#spawn = spawnProcess;
    this.#resolveExecutable = resolveExecutable;
  }

  async start(request: StartStdioRequest): Promise<void> {
    if (this.#sessions.has(request.id)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Duplicate remote stdio session id");
    }
    const launch = resolveRemoteMcpLaunch({
      ...request,
      adapterId: request.adapterId ?? null,
      serverName: request.serverName ?? null,
    });
    assertRemoteMcpLaunch(request.executable, launch.args, request.workspaceRoot);
    const [cwd, executable] = await Promise.all([
      realpath(request.workspaceRoot),
      this.#resolveExecutable(request.executable),
    ]);
    if (!executable) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        `Remote MCP executable was not found: ${request.executable}`,
      );
    }
    const child = this.#spawn(executable, launch.args, {
      cwd,
      env: remoteProcessEnvironment(launch.environment),
      stdio: "pipe",
    });
    const session: StdioSession = { child, outputQueue: Promise.resolve() };
    this.#sessions.set(request.id, session);

    const queueEvent = (event: RemoteStdioEvent): void => {
      session.outputQueue = session.outputQueue
        .catch(() => undefined)
        .then(() => this.#emit(event))
        .catch(() => undefined);
    };
    const queueData = (channel: "stderr" | "stdout", chunk: Buffer): void => {
      const limit = Math.max(1, request.maxFrameBytes);
      for (let offset = 0; offset < chunk.length; offset += limit) {
        const encoded = chunk.subarray(offset, offset + limit).toString("base64");
        queueEvent({ channel, chunk: encoded, event: "data", id: request.id });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => queueData("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => queueData("stderr", chunk));
    child.once("close", (exitCode, signal) => {
      this.#sessions.delete(request.id);
      queueEvent({
        event: "exit",
        exitCode,
        id: request.id,
        signal,
      });
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        this.#sessions.delete(request.id);
        reject(
          new BridgeError(
            "REMOTE_TRANSPORT_DISCONNECTED",
            `Failed to start remote MCP process: ${error.message}`,
            undefined,
            { cause: error },
          ),
        );
      });
    });
  }

  async write(id: string, encodedChunk: string, maxFrameBytes: number): Promise<void> {
    const session = this.#session(id);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedChunk)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Remote stdio input is not valid base64");
    }
    const chunk = Buffer.from(encodedChunk, "base64");
    if (chunk.length > maxFrameBytes) {
      throw new BridgeError("OUTPUT_TRUNCATED", "Remote stdio input frame exceeds the limit");
    }
    await new Promise<void>((resolve, reject) => {
      session.child.stdin.write(chunk, (error) => {
        if (error) {
          reject(
            new BridgeError(
              "REMOTE_TRANSPORT_DISCONNECTED",
              `Unable to write remote MCP stdin: ${error.message}`,
              undefined,
              { cause: error },
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  end(id: string): void {
    this.#session(id).child.stdin.end();
  }

  stop(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) {
      return;
    }
    this.#sessions.delete(id);
    session.child.kill("SIGTERM");
    const force = setTimeout(() => session.child.kill("SIGKILL"), 1_000);
    force.unref();
  }

  close(): void {
    for (const id of [...this.#sessions.keys()]) {
      this.stop(id);
    }
  }

  #session(id: string): StdioSession {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new BridgeError("REMOTE_TRANSPORT_DISCONNECTED", "Remote stdio session is unavailable");
    }
    return session;
  }
}
