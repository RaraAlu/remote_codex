import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { AuditLog } from "../core/audit-log.js";
import { GENERATED_CODEX_APP_SERVER_VERSION } from "../core/compatibility.js";
import { loadBridgeConfig } from "../core/config-store.js";
import { loadOfficialCodexRuntime } from "../core/codex-runtime-store.js";
import { BridgeError } from "../core/errors.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import {
  activeBridgeConfigPath,
  bridgeAuditPath,
  bridgeControlDir,
  officialCodexRuntimePath,
} from "../core/locations.js";
import { validateBundledCodexProtocol } from "../core/official-codex.js";
import type { BridgeConfig } from "../core/types.js";
import { parseMcpProxyInvocation } from "./mcp-proxy-invocation.js";
import { OpenSshMcpRelay } from "./openssh-mcp-relay.js";
import { ShimProxy } from "./proxy.js";
import { routeRemoteMcpServers } from "./remote-mcp.js";
import { VsCodeMcpRelay } from "./vscode-mcp-relay.js";

async function loadOptionalConfig(path: string, audit: AuditLog): Promise<BridgeConfig | null> {
  try {
    return await loadBridgeConfig(path);
  } catch (error) {
    if (error instanceof BridgeError && error.message.includes("does not exist")) {
      await audit.write({
        operation: "shim.config",
        outcome: "failed",
        details: { code: error.code, message: error.message },
      });
      return null;
    }
    throw error;
  }
}

async function passthrough(executable: string, args: readonly string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise(signal ? 128 : (code ?? 1));
    });
  });
}

function assertExecutableIsNotShim(executable: string): void {
  if (resolve(executable) === resolve(process.argv[1] ?? "")) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "The selected official Codex executable resolves to the shim itself",
    );
  }
}

function currentShimRelayLaunch(configPath: string): {
  args: string[];
  command: string;
  sessionConfigPath: string;
} {
  const entry = resolve(process.argv[1] ?? process.execPath);
  return entry === resolve(process.execPath)
    ? { args: [], command: process.execPath, sessionConfigPath: configPath }
    : { args: [entry], command: process.execPath, sessionConfigPath: configPath };
}

async function waitForSessionConfig(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
}

async function selectedCodexExecutable(): Promise<string> {
  const developmentOverride =
    process.env.CODEX_BRIDGE_DEVELOPMENT_CODEX_EXECUTABLE;
  if (developmentOverride) {
    if (
      !isAbsolute(developmentOverride) ||
      normalize(developmentOverride) !== developmentOverride
    ) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "CODEX_BRIDGE_DEVELOPMENT_CODEX_EXECUTABLE must be an absolute path",
      );
    }
    return developmentOverride;
  }
  const runtime = await loadOfficialCodexRuntime(officialCodexRuntimePath());
  validateBundledCodexProtocol(runtime, GENERATED_CODEX_APP_SERVER_VERSION);
  return runtime.executable;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mcpProxy = parseMcpProxyInvocation(args);
  const fallbackExecutable = await selectedCodexExecutable();
  assertExecutableIsNotShim(fallbackExecutable);
  const configPath = mcpProxy?.configPath ?? activeBridgeConfigPath();
  if (!configPath) {
    if (mcpProxy) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay has no active Bridge session");
    }
    return await passthrough(fallbackExecutable, args);
  }

  const auditPath = bridgeAuditPath();
  const audit = new AuditLog(auditPath);
  if (process.env.CODEX_BRIDGE_SESSION_CONFIG) {
    await waitForSessionConfig(configPath);
  }
  const config = await loadOptionalConfig(configPath, audit);
  const codexExecutable = fallbackExecutable;
  assertExecutableIsNotShim(codexExecutable);

  if (mcpProxy) {
    if (!config) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay configuration is unavailable");
    }
    const relayOptions = {
      adapterId: mcpProxy.adapterId,
      args: mcpProxy.args,
      config,
      executable: mcpProxy.executable,
      serverName: mcpProxy.serverName,
    };
    return config.connectionMode === "vscode-remote"
      ? await new VsCodeMcpRelay(relayOptions).run()
      : await new OpenSshMcpRelay(relayOptions).run();
  }

  if (!args.includes("app-server")) {
    return await passthrough(codexExecutable, args);
  }
  if (!config) {
    return await passthrough(codexExecutable, args);
  }

  const controlDir = bridgeControlDir();
  await mkdir(controlDir, { mode: 0o500, recursive: true });
  await chmodIfSupported(controlDir, 0o500);
  let appServerArgs = [...args];
  let localMcpServers: string[] = [];
  let remoteMcpServers: string[] = [];
  let skippedMcpAccessServers: string[] = [];
  let mcpRoutingError: string | undefined;
  try {
    const routing = await routeRemoteMcpServers({
      appServerArgs: args,
      codexExecutable,
      config,
      relay: currentShimRelayLaunch(configPath),
    });
    appServerArgs = routing.appServerArgs;
    localMcpServers = routing.localServers;
    remoteMcpServers = routing.remoteServers;
    skippedMcpAccessServers = routing.skippedAccessServers;
  } catch (error) {
    mcpRoutingError = error instanceof Error ? error.message : String(error);
  }
  await audit.write({
    operation: "shim.start",
    outcome: "started",
    hostId: config.host,
    workspaceRoot: config.workspaceRoot,
    details: {
      appServerArgs,
      bridgeConfigured: true,
      controlDir,
      controlDirectory: {
        path: controlDir,
        role: "control",
        target: "local",
      },
      localMcpServers,
      primaryRoot: config.roots.find(
        (root) => root.target === "remote" && root.role === "primary",
      ),
      remoteMcpAccess: config.remoteMcpAccess,
      remoteMcpRouting: config.remoteMcpRouting,
      remoteMcpServers,
      skippedMcpAccessServers,
      ...(mcpRoutingError ? { mcpRoutingError } : {}),
    },
  });

  const proxy = new ShimProxy({
    appServerArgs,
    auditPath,
    codexExecutable,
    config,
    controlDir,
  });
  return await proxy.run();
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`codex-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
