import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { BridgeError } from "./errors.js";

const LOCAL_LAUNCHERS = new Set([
  "bash",
  "bun",
  "cmd",
  "docker",
  "node",
  "npx",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "sh",
  "ssh",
  "uv",
  "uvx",
]);
const SAFE_REMOTE_ARGUMENT = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SENSITIVE_ARGUMENT =
  /(^|[-_])(api[-_]?key|auth|credential|password|secret|token)([-_=]|$)/i;

export function remoteMcpExecutableName(command: string): string | null {
  const executable = basename(command);
  return /^[A-Za-z0-9._+-]+$/.test(executable) && !LOCAL_LAUNCHERS.has(executable)
    ? executable
    : null;
}

export function areRemoteMcpArgumentsSafe(args: readonly string[]): boolean {
  return args.every(
    (entry) => SAFE_REMOTE_ARGUMENT.test(entry) && !SENSITIVE_ARGUMENT.test(entry),
  );
}

export function assertRemoteMcpLaunch(
  executable: string,
  args: readonly string[],
  workspaceRoot: string,
): void {
  if (remoteMcpExecutableName(executable) !== executable) {
    throw new BridgeError("COMMAND_DENIED", "Remote MCP executable is not eligible for routing");
  }
  if (
    !args.every(
      (entry) =>
        entry === workspaceRoot ||
        (SAFE_REMOTE_ARGUMENT.test(entry) && !SENSITIVE_ARGUMENT.test(entry)),
    )
  ) {
    throw new BridgeError("COMMAND_DENIED", "Remote MCP arguments are not eligible for routing");
  }
}

export async function resolveRemoteMcpExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): Promise<string | null> {
  if (remoteMcpExecutableName(executable) !== executable) {
    return null;
  }
  const candidates = [
    ...(environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, executable)),
    join(homeDirectory, ".local", "bin", executable),
    join("/usr/local/bin", executable),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the bounded candidate list.
    }
  }
  return null;
}
