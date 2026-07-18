import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  areRemoteMcpArgumentsSafe,
  remoteMcpExecutableName,
} from "../core/remote-mcp-policy.js";
import {
  buildSshArgs,
  buildSshEnvironment,
  quotePosix,
} from "../core/ssh-executor.js";
import type { BridgeConfig } from "../core/types.js";
import { VsCodeRemoteExecutor } from "../core/vscode-remote-executor.js";

const execFileAsync = promisify(execFile);

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

interface McpOverrideGroup {
  kind: "access" | "route";
  name: string;
  values: string[];
}

export interface McpRoutingResult {
  appServerArgs: string[];
  localServers: string[];
  remoteServers: string[];
  skippedAccessServers: string[];
}

export interface McpRoutingOptions {
  appServerArgs: readonly string[];
  codexExecutable: string;
  config: BridgeConfig;
  listServers?: () => Promise<CodexMcpServer[]>;
  relay?: { args: string[]; command: string };
  remoteExecutableAvailable?: (executable: string) => Promise<boolean>;
  validateConfigOverrides?: (overrides: readonly string[]) => Promise<boolean>;
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
  const executable = remoteMcpExecutableName(transport.command);
  return (
    executable !== null &&
    (!transport.env || Object.keys(transport.env).length === 0) &&
    (!transport.env_vars || transport.env_vars.length === 0) &&
    !transport.cwd &&
    Array.isArray(transport.args) &&
    transport.args.every((entry) => typeof entry === "string") &&
    areRemoteMcpArgumentsSafe(transport.args)
  );
}

function remoteArgs(server: CodexMcpServer & { transport: StdioTransport }, workspace: string) {
  const executable = remoteMcpExecutableName(server.transport.command);
  if (!executable) {
    throw new TypeError("Remote MCP candidate has no eligible executable");
  }
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

async function validateConfigOverrides(
  codexExecutable: string,
  overrides: readonly string[],
): Promise<boolean> {
  try {
    await execFileAsync(codexExecutable, [...overrides, "mcp", "list", "--json"], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function compatibleOverrideGroups(
  groups: readonly McpOverrideGroup[],
  validate: (overrides: readonly string[]) => Promise<boolean>,
): Promise<McpOverrideGroup[]> {
  if (groups.length === 0) {
    return [];
  }
  const flatten = (items: readonly McpOverrideGroup[]) => items.flatMap((item) => item.values);
  if (await validate(flatten(groups))) {
    return [...groups];
  }

  const accepted: McpOverrideGroup[] = [];
  for (const group of groups) {
    if (await validate(flatten([...accepted, group]))) {
      accepted.push(group);
    }
  }
  return accepted;
}

async function probeRemoteExecutable(
  config: BridgeConfig,
  executable: string,
): Promise<boolean> {
  if (config.connectionMode === "vscode-remote") {
    const executor = new VsCodeRemoteExecutor(config);
    try {
      const result = await executor.execute([
        "sh",
        "-c",
        REMOTE_EXECUTABLE_PROBE,
        "codex-bridge-mcp-probe",
        executable,
      ]);
      return result.exitCode === 0;
    } catch {
      return false;
    } finally {
      executor.close();
    }
  }
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
    skippedAccessServers: [] as string[],
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
        options.config.remoteMcpRouting !== "auto" ||
        (options.config.connectionMode === "vscode-remote" && !options.relay) ||
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
      skippedAccessServers: [],
    };
  }

  const accessGroups: McpOverrideGroup[] =
    options.config.remoteMcpAccess === "all"
      ? servers.map((server) => ({
          kind: "access",
          name: server.name,
          values: [
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
          ],
        }))
      : [];
  const routeGroups: McpOverrideGroup[] = routes.map((route) => {
    const launch =
      options.config.connectionMode === "vscode-remote" && options.relay
        ? {
            args: [
              ...options.relay.args,
              "mcp-proxy",
              route.executable,
              ...route.args,
            ],
            command: options.relay.command,
          }
        : {
            args: buildSshArgs(
              options.config,
              remoteMcpCommand(route, options.config.workspaceRoot),
            ),
            command: options.config.sshExecutable,
          };
    return {
      kind: "route",
      name: route.name,
      values: [
        "-c",
        configOverride(route.name, "command", launch.command),
        "-c",
        configOverride(route.name, "args", launch.args),
      ],
    };
  });
  const validate =
    options.validateConfigOverrides ??
    ((overrides: readonly string[]) => validateConfigOverrides(options.codexExecutable, overrides));
  const acceptedGroups = await compatibleOverrideGroups(
    [...routeGroups, ...accessGroups],
    validate,
  );
  const acceptedRoutes = new Set(
    acceptedGroups.filter((group) => group.kind === "route").map((group) => group.name),
  );
  const acceptedAccess = new Set(
    acceptedGroups.filter((group) => group.kind === "access").map((group) => group.name),
  );
  const remoteServers = routes
    .map((route) => route.name)
    .filter((name) => acceptedRoutes.has(name));
  for (const route of routes) {
    if (!acceptedRoutes.has(route.name)) {
      localServers.push(route.name);
    }
  }
  const skippedAccessServers =
    options.config.remoteMcpAccess === "all"
      ? servers.map((server) => server.name).filter((name) => !acceptedAccess.has(name)).sort()
      : [];
  const overrides = acceptedGroups.flatMap((group) => group.values);
  return {
    appServerArgs: [
      ...options.appServerArgs.slice(0, appServerIndex),
      ...overrides,
      ...options.appServerArgs.slice(appServerIndex),
    ],
    localServers: [...new Set(localServers)].sort(),
    remoteServers,
    skippedAccessServers,
  };
}
