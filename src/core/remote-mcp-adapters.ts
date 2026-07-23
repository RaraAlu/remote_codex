import { BridgeError } from "./errors.js";

export type RemoteMcpAccess = "all" | "enabled";
export type RemoteMcpAdapterId = "codegraph-all-tools-v1";

export interface RemoteMcpAdapterSelection {
  access: RemoteMcpAccess;
  executable: string;
  serverName: string;
}

export interface RemoteMcpLaunch {
  args: string[];
  environment: Record<string, string>;
}

export interface RemoteMcpLaunchRequest {
  adapterId: string | null;
  args: readonly string[];
  executable: string;
  serverName: string | null;
  workspaceRoot: string;
}

interface RemoteMcpAdapter {
  id: RemoteMcpAdapterId;
  matches: (selection: RemoteMcpAdapterSelection) => boolean;
  resolve: (request: RemoteMcpLaunchRequest) => RemoteMcpLaunch;
}

const CODEGRAPH_ALL_TOOLS: RemoteMcpLaunch["environment"] = {
  CODEGRAPH_MCP_TOOLS: "search,callers,callees,impact,node,explore,status,files",
};
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_ENVIRONMENT_VALUE = /^[A-Za-z0-9][A-Za-z0-9,._+:/-]{0,4095}$/;
const SENSITIVE_ENVIRONMENT_NAME =
  /(^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:_|$)|^(?:CHATGPT|CODEX|ELECTRON|OPENAI|VSCODE)_/i;

function assertAdapterEnvironment(environment: Readonly<Record<string, string>>): void {
  const entries = Object.entries(environment);
  if (entries.length > 16) {
    throw new BridgeError("COMMAND_DENIED", "Remote MCP adapter environment is too large");
  }
  for (const [name, value] of entries) {
    if (!SAFE_ENVIRONMENT_NAME.test(name) || SENSITIVE_ENVIRONMENT_NAME.test(name)) {
      throw new BridgeError(
        "COMMAND_DENIED",
        `Remote MCP adapter environment name is not eligible: ${name}`,
      );
    }
    if (!SAFE_ENVIRONMENT_VALUE.test(value)) {
      throw new BridgeError(
        "COMMAND_DENIED",
        `Remote MCP adapter environment value is not eligible: ${name}`,
      );
    }
  }
}

const REMOTE_MCP_ADAPTERS: readonly RemoteMcpAdapter[] = [
  {
    id: "codegraph-all-tools-v1",
    matches: (selection) =>
      selection.access === "all" &&
      selection.serverName === "codegraph" &&
      selection.executable === "codegraph",
    resolve: (request) => {
      if (
        request.serverName !== "codegraph" ||
        request.executable !== "codegraph" ||
        !request.args.some(
          (entry, index) =>
            (entry === "--path" || entry === "-p") &&
            request.args[index + 1] === request.workspaceRoot,
        )
      ) {
        throw new BridgeError("COMMAND_DENIED", "Remote MCP adapter does not match the launch");
      }
      return {
        args: [...request.args],
        environment: { ...CODEGRAPH_ALL_TOOLS },
      };
    },
  },
];

export function selectRemoteMcpAdapter(
  selection: RemoteMcpAdapterSelection,
): RemoteMcpAdapterId | null {
  return REMOTE_MCP_ADAPTERS.find((adapter) => adapter.matches(selection))?.id ?? null;
}

export function resolveRemoteMcpLaunch(request: RemoteMcpLaunchRequest): RemoteMcpLaunch {
  if (request.adapterId === null) {
    return { args: [...request.args], environment: {} };
  }
  const adapter = REMOTE_MCP_ADAPTERS.find((candidate) => candidate.id === request.adapterId);
  if (!adapter) {
    throw new BridgeError("COMMAND_DENIED", "Remote MCP adapter is not registered");
  }
  const launch = adapter.resolve(request);
  assertAdapterEnvironment(launch.environment);
  return launch;
}
