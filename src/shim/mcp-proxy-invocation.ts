import { isAbsolute } from "node:path";
import { BridgeError } from "../core/errors.js";

const MCP_PROXY_MODE = "mcp-proxy";

export interface McpProxyInvocation {
  args: string[];
  configPath: string | null;
  executable: string;
}

export function parseMcpProxyInvocation(
  args: readonly string[],
): McpProxyInvocation | null {
  if (args[0] !== MCP_PROXY_MODE) {
    return null;
  }
  if (args[1] === "--session-config") {
    const configPath = args[2];
    const executable = args[3];
    if (!configPath || !isAbsolute(configPath) || !executable) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay session arguments are invalid");
    }
    return { args: args.slice(4), configPath, executable };
  }
  const executable = args[1];
  if (!executable) {
    throw new BridgeError("INVALID_CONFIG", "Remote MCP relay executable is missing");
  }
  return { args: args.slice(2), configPath: null, executable };
}
