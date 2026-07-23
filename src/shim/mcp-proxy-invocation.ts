import { isAbsolute } from "node:path";
import { BridgeError } from "../core/errors.js";

const MCP_PROXY_MODE = "mcp-proxy";

export interface McpProxyInvocation {
  adapterId: string | null;
  args: string[];
  configPath: string | null;
  executable: string;
  serverName: string | null;
}

export function parseMcpProxyInvocation(
  args: readonly string[],
): McpProxyInvocation | null {
  if (args[0] !== MCP_PROXY_MODE) {
    return null;
  }
  let index = 1;
  let configPath: string | null = null;
  let serverName: string | null = null;
  let adapterId: string | null = null;
  if (args[index] === "--session-config") {
    configPath = args[index + 1] ?? null;
    if (!configPath || !isAbsolute(configPath)) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay session arguments are invalid");
    }
    index += 2;
  }
  if (args[index] === "--server-name") {
    serverName = args[index + 1] ?? null;
    if (!serverName || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(serverName)) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay server name is invalid");
    }
    index += 2;
  }
  if (args[index] === "--adapter") {
    adapterId = args[index + 1] ?? null;
    if (!adapterId || !/^[A-Za-z0-9._-]+$/.test(adapterId) || !serverName) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay adapter is invalid");
    }
    index += 2;
  }
  const executable = args[index];
  if (!executable) {
    throw new BridgeError("INVALID_CONFIG", "Remote MCP relay executable is missing");
  }
  return {
    adapterId,
    args: args.slice(index + 1),
    configPath,
    executable,
    serverName,
  };
}
