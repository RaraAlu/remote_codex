import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { BridgeError } from "../core/errors.js";
import { resolveRemoteMcpLaunch } from "../core/remote-mcp-adapters.js";
import { assertRemoteMcpLaunch } from "../core/remote-mcp-policy.js";
import {
  buildSshArgs,
  buildSshEnvironment,
  quotePosix,
} from "../core/ssh-executor.js";
import type { BridgeConfig } from "../core/types.js";

const REMOTE_MCP_ADAPTER_LAUNCHER = [
  "set -eu",
  'executable="$1"',
  'workspace="$2"',
  "shift 2",
  'IFS= read -r bridge_env_count || { printf "codex-bridge: missing MCP adapter header\\n" >&2; exit 126; }',
  'case "$bridge_env_count" in',
  '  ""|*[!0-9]*) printf "codex-bridge: invalid MCP adapter header\\n" >&2; exit 126 ;;',
  "esac",
  '[ "$bridge_env_count" -le 16 ] || { printf "codex-bridge: MCP adapter header is too large\\n" >&2; exit 126; }',
  "bridge_env_index=0",
  'while [ "$bridge_env_index" -lt "$bridge_env_count" ]; do',
  '  IFS= read -r bridge_assignment || { printf "codex-bridge: incomplete MCP adapter header\\n" >&2; exit 126; }',
  '  bridge_name="${bridge_assignment%%=*}"',
  '  case "$bridge_name" in',
  '    ""|[0-9]*|*[!A-Za-z0-9_]*) printf "codex-bridge: invalid MCP adapter environment\\n" >&2; exit 126 ;;',
  "  esac",
  '  export "$bridge_assignment"',
  "  bridge_env_index=$((bridge_env_index + 1))",
  "done",
  'remote_bin="$(command -v "$executable" || true)"',
  'if [ -z "$remote_bin" ] && [ -x "$HOME/.local/bin/$executable" ]; then',
  '  remote_bin="$HOME/.local/bin/$executable"',
  "fi",
  'if [ -z "$remote_bin" ] && [ -x "/usr/local/bin/$executable" ]; then',
  '  remote_bin="/usr/local/bin/$executable"',
  "fi",
  'if [ -z "$remote_bin" ]; then',
  '  printf "codex-bridge: remote MCP executable %s was not found\\n" "$executable" >&2',
  "  exit 127",
  "fi",
  'cd "$workspace"',
  'exec "$remote_bin" "$@"',
].join("\n");

type SpawnMcpSsh = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface OpenSshMcpRelayOptions {
  adapterId: string | null;
  args: readonly string[];
  config: BridgeConfig;
  errorOutput?: Writable;
  executable: string;
  input?: Readable;
  output?: Writable;
  serverName: string | null;
  spawnProcess?: SpawnMcpSsh;
}

function remoteCommand(executable: string, workspaceRoot: string, args: readonly string[]): string {
  return [
    "sh",
    "-c",
    quotePosix(REMOTE_MCP_ADAPTER_LAUNCHER),
    "codex-bridge-mcp",
    quotePosix(executable),
    quotePosix(workspaceRoot),
    ...args.map(quotePosix),
  ].join(" ");
}

function environmentHeader(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment);
  return `${[String(entries.length), ...entries.map(([name, value]) => `${name}=${value}`)].join("\n")}\n`;
}

export class OpenSshMcpRelay {
  readonly #options: OpenSshMcpRelayOptions;

  constructor(options: OpenSshMcpRelayOptions) {
    this.#options = options;
  }

  async run(): Promise<number> {
    const config = this.#options.config;
    if (config.connectionMode !== "openssh") {
      throw new BridgeError("INVALID_CONFIG", "OpenSSH MCP relay requires openssh mode");
    }
    const launch = resolveRemoteMcpLaunch({
      adapterId: this.#options.adapterId,
      args: this.#options.args,
      executable: this.#options.executable,
      serverName: this.#options.serverName,
      workspaceRoot: config.workspaceRoot,
    });
    assertRemoteMcpLaunch(this.#options.executable, launch.args, config.workspaceRoot);
    const spawnProcess = this.#options.spawnProcess ?? spawn;
    const input = this.#options.input ?? process.stdin;
    const output = this.#options.output ?? process.stdout;
    const errorOutput = this.#options.errorOutput ?? process.stderr;
    const child = spawnProcess(
      config.sshExecutable,
      buildSshArgs(
        config,
        remoteCommand(this.#options.executable, config.workspaceRoot, launch.args),
      ),
      {
        env: buildSshEnvironment(),
        stdio: "pipe",
        windowsHide: true,
      },
    );
    child.stdin.write(environmentHeader(launch.environment));
    input.pipe(child.stdin);
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(errorOutput, { end: false });

    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
    });
  }
}
