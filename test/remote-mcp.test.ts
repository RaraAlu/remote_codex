import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import {
  type CodexMcpServer,
  routeRemoteMcpServers,
} from "../src/shim/remote-mcp.js";

const config = parseBridgeConfig({
  host: "training-gpu",
  workspaceRoot: "/remote/workspace with spaces",
  sshUser: "root",
  sshPort: 42013,
  identityFile: "/home/user/.ssh/id_ed25519",
});

function stdioServer(
  name: string,
  command: string,
  overrides: Partial<CodexMcpServer["transport"]> = {},
): CodexMcpServer {
  return {
    name,
    enabled: true,
    transport: {
      type: "stdio",
      command,
      args: [],
      env: null,
      env_vars: [],
      cwd: null,
      ...overrides,
    },
  } as CodexMcpServer;
}

describe("remote MCP routing", () => {
  it("scans enabled MCPs and injects safe SSH routes before app-server", async () => {
    const servers = [
      stdioServer("codegraph", "codegraph", { args: ["serve", "--mcp"] }),
      stdioServer("local-secret", "secret-mcp", { env: { TOKEN: "secret" } }),
      stdioServer("argument-secret", "secret-mcp", {
        args: ["--token", "do-not-copy"],
      }),
      stdioServer("local-path", "path-mcp", { args: ["/home/user/project"] }),
      stdioServer("package-runner", "npx", { args: ["-y", "some-mcp"] }),
      { name: "web", enabled: true, transport: { type: "streamable_http" } },
      { name: "disabled", enabled: false, transport: { type: "stdio" } },
    ] as CodexMcpServer[];
    const original = ["-c", "features.code_mode_host=true", "app-server"];
    const result = await routeRemoteMcpServers({
      appServerArgs: original,
      codexExecutable: "codex",
      config,
      listServers: async () => servers,
      remoteExecutableAvailable: async (executable) => executable === "codegraph",
    });

    expect(result.remoteServers).toEqual(["codegraph"]);
    expect(result.localServers).toEqual([
      "argument-secret",
      "local-path",
      "local-secret",
      "package-runner",
      "web",
    ]);
    const appServerIndex = result.appServerArgs.indexOf("app-server");
    expect(result.appServerArgs.slice(appServerIndex - 4, appServerIndex)[1]).toBe(
      'mcp_servers.codegraph.command="ssh"',
    );
    const encodedOverride = result.appServerArgs[appServerIndex - 1] ?? "";
    const encodedArgs = encodedOverride.slice(encodedOverride.indexOf("=") + 1);
    const sshArgs = JSON.parse(encodedArgs) as string[];
    expect(sshArgs).toContain("BatchMode=yes");
    expect(sshArgs).toContain("42013");
    expect(sshArgs.at(-2)).toBe("training-gpu");
    expect(sshArgs.at(-1)).toContain('exec "$remote_bin" "$@"');
    expect(sshArgs.at(-1)).toContain("'--path'");
    expect(sshArgs.at(-1)).toContain("'/remote/workspace with spaces'");
  });

  it("keeps a candidate local when the executable is absent remotely", async () => {
    const result = await routeRemoteMcpServers({
      appServerArgs: ["app-server"],
      codexExecutable: "codex",
      config,
      listServers: async () => [stdioServer("index", "/home/user/.local/bin/index-mcp")],
      remoteExecutableAvailable: async () => false,
    });
    expect(result.appServerArgs).toEqual(["app-server"]);
    expect(result.localServers).toEqual(["index"]);
    expect(result.remoteServers).toEqual([]);
  });

  it("supports a window-level local-only fallback", async () => {
    const localConfig = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
      remoteMcpRouting: "local",
    });
    let scanned = false;
    const result = await routeRemoteMcpServers({
      appServerArgs: ["app-server"],
      codexExecutable: "codex",
      config: localConfig,
      listServers: async () => {
        scanned = true;
        return [];
      },
    });
    expect(scanned).toBe(false);
    expect(result.appServerArgs).toEqual(["app-server"]);
  });
});
