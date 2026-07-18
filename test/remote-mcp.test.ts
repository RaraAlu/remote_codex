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
      validateConfigOverrides: async () => true,
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

  it("enables and approves every configured MCP for only this app-server", async () => {
    const allConfig = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
      remoteMcpAccess: "all",
    });
    const codegraph = stdioServer("codegraph", "codegraph", {
      args: ["serve", "--mcp"],
    });
    codegraph.enabled = false;
    const blender = stdioServer("blender", "uvx", {
      args: ["--python", "3.11", "blender-mcp"],
      env: { BLENDER_HOST: "localhost" },
    });
    blender.enabled = false;

    const result = await routeRemoteMcpServers({
      appServerArgs: ["app-server"],
      codexExecutable: "codex",
      config: allConfig,
      listServers: async () => [blender, codegraph],
      remoteExecutableAvailable: async (executable) => executable === "codegraph",
      validateConfigOverrides: async () => true,
    });

    expect(result.localServers).toEqual(["blender"]);
    expect(result.remoteServers).toEqual(["codegraph"]);
    for (const name of ["blender", "codegraph"]) {
      expect(result.appServerArgs).toContain(`mcp_servers.${name}.enabled=true`);
      expect(result.appServerArgs).toContain(
        `mcp_servers.${name}.disabled_tools=[]`,
      );
      expect(result.appServerArgs).toContain(
        `mcp_servers.${name}.default_tools_approval_mode="approve"`,
      );
    }
    expect(result.appServerArgs).toContain(
      'mcp_servers.codegraph.command="ssh"',
    );
  });

  it("can enable all MCPs while keeping every server local", async () => {
    const allLocalConfig = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
      remoteMcpRouting: "local",
      remoteMcpAccess: "all",
    });
    const disabled = stdioServer("disabled", "example-mcp");
    disabled.enabled = false;

    const result = await routeRemoteMcpServers({
      appServerArgs: ["app-server"],
      codexExecutable: "codex",
      config: allLocalConfig,
      listServers: async () => [disabled],
      validateConfigOverrides: async () => true,
    });

    expect(result.localServers).toEqual(["disabled"]);
    expect(result.remoteServers).toEqual([]);
    expect(result.appServerArgs).toContain("mcp_servers.disabled.enabled=true");
    expect(result.appServerArgs).not.toContain(
      'mcp_servers.disabled.command="ssh"',
    );
  });

  it("routes safe stdio MCPs through the active VS Code Remote transport", async () => {
    const vscodeConfig = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace with spaces",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
      vscodeTransport: {
        endpoint: "local-endpoint",
        sessionId: "session",
        token: "0123456789abcdef0123456789abcdef",
      },
    });
    const result = await routeRemoteMcpServers({
      appServerArgs: ["app-server"],
      codexExecutable: "codex",
      config: vscodeConfig,
      listServers: async () => [
        stdioServer("codegraph", "codegraph", { args: ["serve", "--mcp"] }),
      ],
      relay: {
        args: [],
        command: "C:\\bridge\\codex-bridge-shim.exe",
        sessionConfigPath: "C:\\bridge\\sessions\\123.json",
      },
      remoteExecutableAvailable: async () => true,
      validateConfigOverrides: async () => true,
    });

    expect(result.remoteServers).toEqual(["codegraph"]);
    expect(result.appServerArgs).toContain(
      'mcp_servers.codegraph.command="C:\\\\bridge\\\\codex-bridge-shim.exe"',
    );
    const argsOverride = result.appServerArgs.find((entry) =>
      entry.startsWith("mcp_servers.codegraph.args="),
    );
    expect(JSON.parse(argsOverride?.split("=").slice(1).join("=") ?? "[]")).toEqual([
      "mcp-proxy",
      "--session-config",
      "C:\\bridge\\sessions\\123.json",
      "codegraph",
      "serve",
      "--mcp",
      "--path",
      "/remote/workspace with spaces",
    ]);
    expect(result.appServerArgs).not.toContain('mcp_servers.codegraph.command="ssh"');
  });

  it("keeps plugin-layer MCP transport intact when access overrides are incompatible", async () => {
    const allLocalConfig = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
      remoteMcpRouting: "local",
      remoteMcpAccess: "all",
    });
    const codegraph = stdioServer("codegraph", "codegraph");
    const pluginServer = stdioServer("sites-design-picker", "node", {
      cwd: "/plugin/sites",
    });

    const result = await routeRemoteMcpServers({
      appServerArgs: ["app-server"],
      codexExecutable: "codex",
      config: allLocalConfig,
      listServers: async () => [codegraph, pluginServer],
      validateConfigOverrides: async (overrides) =>
        !overrides.some((entry) => entry.includes("sites-design-picker")),
    });

    expect(result.appServerArgs).toContain("mcp_servers.codegraph.enabled=true");
    expect(result.appServerArgs.some((entry) => entry.includes("sites-design-picker"))).toBe(false);
    expect(result.skippedAccessServers).toEqual(["sites-design-picker"]);
  });
});
