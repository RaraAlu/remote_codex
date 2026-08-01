import { BridgeError } from "./errors.js";

const WINDOWS_COMMAND_SCRIPT = /\.(?:bat|cmd)$/i;
const UNSAFE_WINDOWS_SHELL_VALUE = /[\0\r\n"%&()<>^|]/;

export interface ChildProcessCommandOptions {
  environment?: NodeJS.ProcessEnv;
  hostPlatform?: NodeJS.Platform;
}

export interface ChildProcessCommand {
  args: string[];
  command: string;
}

export function prepareChildProcessCommand(
  executable: string,
  args: readonly string[],
  options: ChildProcessCommandOptions = {},
): ChildProcessCommand {
  const hostPlatform = options.hostPlatform ?? process.platform;
  if (hostPlatform !== "win32" || !WINDOWS_COMMAND_SCRIPT.test(executable)) {
    return { command: executable, args: [...args] };
  }

  for (const value of [executable, ...args]) {
    if (UNSAFE_WINDOWS_SHELL_VALUE.test(value)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Windows command-script invocation contains unsupported shell characters",
      );
    }
  }

  const environment = options.environment ?? process.env;
  const command = environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe";
  return {
    command,
    args: ["/d", "/s", "/c", executable, ...args],
  };
}
