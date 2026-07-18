import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditLog } from "../core/audit-log.js";
import { resolveCodexExecutable } from "../core/codex-executable.js";
import { loadBridgeConfig } from "../core/config-store.js";
import { BridgeError } from "../core/errors.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import {
  activeBridgeConfigPath,
  bridgeAuditPath,
  bridgeControlDir,
} from "../core/locations.js";
import type { BridgeConfig } from "../core/types.js";
import { ShimProxy } from "./proxy.js";
import { routeRemoteMcpServers } from "./remote-mcp.js";

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
      "CODEX_BRIDGE_CODEX_EXECUTABLE resolves to the shim itself",
    );
  }
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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const fallbackExecutable = resolveCodexExecutable(
    process.env.CODEX_BRIDGE_CODEX_EXECUTABLE || "codex",
  );
  assertExecutableIsNotShim(fallbackExecutable);
  const configPath = activeBridgeConfigPath();
  if (!configPath) {
    return await passthrough(fallbackExecutable, args);
  }

  const auditPath = bridgeAuditPath();
  const audit = new AuditLog(auditPath);
  if (process.env.CODEX_BRIDGE_SESSION_CONFIG) {
    await waitForSessionConfig(configPath);
  }
  const config = await loadOptionalConfig(configPath, audit);
  const codexExecutable = resolveCodexExecutable(
    process.env.CODEX_BRIDGE_CODEX_EXECUTABLE || config?.codexExecutable || fallbackExecutable,
  );
  assertExecutableIsNotShim(codexExecutable);

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
  let mcpRoutingError: string | undefined;
  try {
    const routing = await routeRemoteMcpServers({
      appServerArgs: args,
      codexExecutable,
      config,
    });
    appServerArgs = routing.appServerArgs;
    localMcpServers = routing.localServers;
    remoteMcpServers = routing.remoteServers;
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
      localMcpServers,
      remoteMcpAccess: config.remoteMcpAccess,
      remoteMcpRouting: config.remoteMcpRouting,
      remoteMcpServers,
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
