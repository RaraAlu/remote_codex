import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  buildSshArgs,
  buildSshEnvironment,
  quotePosix,
} from "../core/ssh-executor.js";
import type { BridgeConfig } from "../core/types.js";

const execFileAsync = promisify(execFile);
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

const REMOTE_MCP_LAUNCHER = [
  "set -eu",
  'executable="$1"',
  'workspace="$2"',
  "shift 2",
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

const REMOTE_EXECUTABLE_PROBE = [
  'executable="$1"',
  'command -v "$executable" >/dev/null 2>&1 ||',
  '  test -x "$HOME/.local/bin/$executable" ||',
  '  test -x "/usr/local/bin/$executable"',
].join("\n");

interface StdioTransport {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string> | null;
  env_vars: string[];
  cwd: string | null;
}

export interface CodexMcpServer {
  name: string;
  enabled: boolean;
  transport: StdioTransport | { type: string };
}

type McpConfigProperty =
  | "args"
  | "command"
  | "default_tools_approval_mode"
  | "disabled_tools"
  | "enabled";

interface RemoteMcpRoute {
  name: string;
  executable: string;
  args: string[];
}

export interface McpRoutingResult {
  appServerArgs: string[];
  localServers: string[];
  remoteServers: string[];
}

export interface McpRoutingOptions {
  appServerArgs: readonly string[];
  codexExecutable: string;
  config: BridgeConfig;
  listServers?: () => Promise<CodexMcpServer[]>;
  remoteExecutableAvailable?: (executable: string) => Promise<boolean>;
}

function configKey(name: string, property: McpConfigProperty): string {
  const component = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  return `mcp_servers.${component}.${property}`;
}

function configOverride(
  name: string,
  property: McpConfigProperty,
  value: boolean | string | readonly string[],
): string {
  return `${configKey(name, property)}=${JSON.stringify(value)}`;
}

function isRemoteCandidate(server: CodexMcpServer): server is CodexMcpServer & {
  transport: StdioTransport;
} {
  if (server.transport.type !== "stdio") {
    return false;
  }
  const transport = server.transport as StdioTransport;
  const executable = basename(transport.command);
  return (
    /^[A-Za-z0-9._+-]+$/.test(executable) &&
    !LOCAL_LAUNCHERS.has(executable) &&
    (!transport.env || Object.keys(transport.env).length === 0) &&
    (!transport.env_vars || transport.env_vars.length === 0) &&
    !transport.cwd &&
    Array.isArray(transport.args) &&
    transport.args.every(
      (entry) =>
        typeof entry === "string" &&
        SAFE_REMOTE_ARGUMENT.test(entry) &&
        !SENSITIVE_ARGUMENT.test(entry),
    )
  );
}

function remoteArgs(server: CodexMcpServer & { transport: StdioTransport }, workspace: string) {
  const executable = basename(server.transport.command);
  const args = [...server.transport.args];
  if (
    executable === "codegraph" &&
    !args.some((entry) => entry === "--path" || entry === "-p")
  ) {
    args.push("--path", workspace);
  }
  return { executable, args };
}

function remoteMcpCommand(route: RemoteMcpRoute, workspaceRoot: string): string {
  return [
    "sh",
    "-c",
    quotePosix(REMOTE_MCP_LAUNCHER),
    "codex-bridge-mcp",
    quotePosix(route.executable),
    quotePosix(workspaceRoot),
    ...route.args.map(quotePosix),
  ].join(" ");
}

async function listCodexMcpServers(codexExecutable: string): Promise<CodexMcpServer[]> {
  const { stdout } = await execFileAsync(codexExecutable, ["mcp", "list", "--json"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? (parsed as CodexMcpServer[]) : [];
}

async function probeRemoteExecutable(
  config: BridgeConfig,
  executable: string,
): Promise<boolean> {
  const remoteCommand = [
    "sh",
    "-c",
    quotePosix(REMOTE_EXECUTABLE_PROBE),
    "codex-bridge-mcp-probe",
    quotePosix(executable),
  ].join(" ");
  const args = buildSshArgs(config, remoteCommand);
  return await new Promise<boolean>((resolvePromise) => {
    const child = execFile(
      config.sshExecutable,
      args,
      {
        encoding: "utf8",
        env: buildSshEnvironment(),
        timeout: Math.max(5_000, config.connectTimeoutSeconds * 1_000 + 1_000),
      },
      (error) => resolvePromise(!error),
    );
    child.stdin?.end();
  });
}

export async function routeRemoteMcpServers(
  options: McpRoutingOptions,
): Promise<McpRoutingResult> {
  const unchanged = {
    appServerArgs: [...options.appServerArgs],
    localServers: [] as string[],
    remoteServers: [] as string[],
  };
  if (
    options.config.remoteMcpRouting !== "auto" &&
    options.config.remoteMcpAccess !== "all"
  ) {
    return unchanged;
  }

  const listServers =
    options.listServers ?? (() => listCodexMcpServers(options.codexExecutable));
  const available =
    options.remoteExecutableAvailable ??
    ((executable: string) => probeRemoteExecutable(options.config, executable));
  const configuredServers = await listServers();
  const servers =
    options.config.remoteMcpAccess === "all"
      ? configuredServers
      : configuredServers.filter((server) => server.enabled);
  const routes: RemoteMcpRoute[] = [];
  const localServers: string[] = [];

  await Promise.all(
    servers.map(async (server) => {
      if (
        options.config.connectionMode !== "openssh" ||
        options.config.remoteMcpRouting !== "auto" ||
        !isRemoteCandidate(server)
      ) {
        localServers.push(server.name);
        return;
      }
      const route = remoteArgs(server, options.config.workspaceRoot);
      if (await available(route.executable)) {
        routes.push({ name: server.name, ...route });
      } else {
        localServers.push(server.name);
      }
    }),
  );

  routes.sort((left, right) => left.name.localeCompare(right.name));
  localServers.sort();
  const appServerIndex = options.appServerArgs.indexOf("app-server");
  if (appServerIndex < 0) {
    return {
      appServerArgs: [...options.appServerArgs],
      localServers,
      remoteServers: routes.map((route) => route.name),
    };
  }

  const accessOverrides =
    options.config.remoteMcpAccess === "all"
      ? servers.flatMap((server) => [
          "-c",
          configOverride(server.name, "enabled", true),
          "-c",
          configOverride(server.name, "disabled_tools", []),
          "-c",
          configOverride(
            server.name,
            "default_tools_approval_mode",
            "approve",
          ),
        ])
      : [];
  const routeOverrides = routes.flatMap((route) => {
    const sshArgs = buildSshArgs(
      options.config,
      remoteMcpCommand(route, options.config.workspaceRoot),
    );
    return [
      "-c",
      configOverride(route.name, "command", options.config.sshExecutable),
      "-c",
      configOverride(route.name, "args", sshArgs),
    ];
  });
  const overrides = [...accessOverrides, ...routeOverrides];
  return {
    appServerArgs: [
      ...options.appServerArgs.slice(0, appServerIndex),
      ...overrides,
      ...options.appServerArgs.slice(appServerIndex),
    ],
    localServers,
    remoteServers: routes.map((route) => route.name),
  };
}
