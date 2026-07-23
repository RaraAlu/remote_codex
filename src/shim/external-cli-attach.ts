import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { BridgeError } from "../core/errors.js";
import { bridgeExternalCliIntegrationPath } from "../core/locations.js";
import { isRecord } from "./rpc.js";
import { discoverExternalCliSessions } from "./external-session-registry.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";

const execFileAsync = promisify(execFile);
const TOKEN_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ExternalCliIntegrationConfig {
  version: 1 | 2;
  codexExecutable: string;
  launcherPath: string;
  shimPath: string;
}

export interface ExternalCliAttachOptions {
  codexExecutable?: string;
  host?: string;
  sessionPid?: number;
  threadId?: string;
  workspaceRoot?: string;
}

export interface PreparedExternalCliAttach {
  args: string[];
  command: string;
  descriptor: ExternalCliSessionDescriptor;
  environment: NodeJS.ProcessEnv;
  threadId: string;
}

export type RunCodexHelp = (
  executable: string,
  args: readonly string[],
) => Promise<string>;

export type SpawnAttachedCodex = (
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
    windowsHide: boolean;
  },
) => ChildProcess;

function parseIntegrationConfig(value: unknown): ExternalCliIntegrationConfig {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.codexExecutable !== "string" ||
    value.codexExecutable.length === 0 ||
    typeof value.launcherPath !== "string" ||
    typeof value.shimPath !== "string"
  ) {
    throw new BridgeError("INVALID_CONFIG", "External CLI integration config is invalid");
  }
  return value as unknown as ExternalCliIntegrationConfig;
}

export async function configuredCodexExecutable(
  requireConfiguration = false,
): Promise<string> {
  try {
    return parseIntegrationConfig(
      JSON.parse(
        await readFile(bridgeExternalCliIntegrationPath(), "utf8"),
      ) as unknown,
    ).codexExecutable;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      if (requireConfiguration) {
        throw new BridgeError(
          "INVALID_CONFIG",
          "Automatic Codex CLI launcher recovery metadata is unavailable",
        );
      }
      return "codex";
    }
    if (error instanceof SyntaxError) {
      throw new BridgeError("INVALID_CONFIG", "External CLI integration config is invalid");
    }
    throw error;
  }
}

export function selectAutomaticExternalCliSession(
  sessions: readonly ExternalCliSessionDescriptor[],
  workspaceRoot: string,
): ExternalCliSessionDescriptor | null {
  const eligible = sessions.filter((session) => session.threadId !== undefined);
  const matchingWorkspace = eligible.filter(
    (session) => session.workspaceRoot === workspaceRoot,
  );
  if (matchingWorkspace.length === 1) {
    return matchingWorkspace[0]!;
  }
  if (matchingWorkspace.length > 1 || eligible.length > 1) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "More than one active VS Code Codex thread matches the plain Codex launcher; use codex-vscode --session-pid <pid>",
    );
  }
  return eligible[0] ?? null;
}

export async function automaticExternalCliAttachOptions(
  workspaceRoot = process.cwd(),
): Promise<ExternalCliAttachOptions | null> {
  const selected = selectAutomaticExternalCliSession(
    await discoverExternalCliSessions(),
    workspaceRoot,
  );
  return selected ? { sessionPid: selected.pid } : null;
}

function selectSession(
  sessions: readonly ExternalCliSessionDescriptor[],
  options: ExternalCliAttachOptions,
): ExternalCliSessionDescriptor {
  const eligible = sessions.filter(
    (session) =>
      session.threadId !== undefined &&
      (options.host === undefined || session.host === options.host) &&
      (options.workspaceRoot === undefined ||
        session.workspaceRoot === options.workspaceRoot) &&
      (options.sessionPid === undefined || session.pid === options.sessionPid) &&
      (options.threadId === undefined || session.threadId === options.threadId),
  );
  if (eligible.length === 0) {
    throw new BridgeError(
      "BRIDGE_NOT_READY",
      "No active VS Code Codex thread matches the requested Bridge session",
    );
  }
  if (eligible.length > 1) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "More than one active VS Code Codex thread matches; specify --session-pid",
    );
  }
  return eligible[0]!;
}

export async function prepareExternalCliAttach(
  options: ExternalCliAttachOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PreparedExternalCliAttach> {
  const descriptor = selectSession(await discoverExternalCliSessions(), options);
  const threadId = options.threadId ?? descriptor.threadId;
  if (!threadId) {
    throw new BridgeError("BRIDGE_NOT_READY", "The active Bridge session has no Codex thread");
  }
  if (!TOKEN_ENVIRONMENT_NAME.test(descriptor.tokenEnv)) {
    throw new BridgeError("INVALID_CONFIG", "VS Code Codex gateway token environment is invalid");
  }
  const token = await readFile(descriptor.tokenPath, "utf8");
  if (!token || /[\r\n]/.test(token)) {
    throw new BridgeError("INVALID_CONFIG", "VS Code Codex gateway token is invalid");
  }
  const command = options.codexExecutable ?? (await configuredCodexExecutable());
  if (!command) {
    throw new BridgeError("INVALID_CONFIG", "External Codex CLI executable is empty");
  }
  return {
    args: [
      "resume",
      "--remote",
      descriptor.endpoint,
      "--remote-auth-token-env",
      descriptor.tokenEnv,
      threadId,
    ],
    command,
    descriptor,
    environment: { ...environment, [descriptor.tokenEnv]: token },
    threadId,
  };
}

const runCodexHelp: RunCodexHelp = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
};

export async function assertRemoteAttachSupported(
  executable: string,
  run: RunCodexHelp = runCodexHelp,
): Promise<void> {
  const help = await run(executable, ["resume", "--help"]);
  if (!help.includes("--remote") || !help.includes("--remote-auth-token-env")) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "The configured Codex CLI does not support authenticated remote resume",
    );
  }
}

export async function runExternalCliAttach(
  options: ExternalCliAttachOptions = {},
  runHelp: RunCodexHelp = runCodexHelp,
  spawnCodex: SpawnAttachedCodex = spawn,
): Promise<number> {
  const prepared = await prepareExternalCliAttach(options);
  await assertRemoteAttachSupported(prepared.command, runHelp);
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawnCodex(prepared.command, prepared.args, {
      env: prepared.environment,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise(signal ? 128 : (code ?? 1));
    });
  });
}
