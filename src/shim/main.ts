import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { basename, isAbsolute, normalize, resolve } from "node:path";
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
import {
  automaticExternalCliAttachOptions,
  configuredCodexExecutable,
  runExternalCliAttach,
  type ExternalCliAttachOptions,
} from "./external-cli-attach.js";
import { runExternalMcpServer } from "./external-mcp.js";
import { parseMcpProxyInvocation } from "./mcp-proxy-invocation.js";
import { OpenSshMcpRelay } from "./openssh-mcp-relay.js";
import { withRemoteCorePolicy } from "./local-core-policy.js";
import { routeRemoteMcpServers } from "./remote-mcp.js";
import { SharedAppServer } from "./shared-app-server.js";
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

function invocationNames(): string[] {
  return [process.argv[1], process.execPath]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => basename(entry).toLowerCase());
}

function isManagedExternalCliLauncher(): boolean {
  return invocationNames().some(
    (name) => name === "codex-vscode" || name === "codex-vscode.exe",
  );
}

function isManagedAutomaticCliLauncher(): boolean {
  return invocationNames().some(
    (name) => name === "codex" || name === "codex.exe",
  );
}

function parseExternalCliAttachOptions(args: readonly string[]): ExternalCliAttachOptions {
  const options: ExternalCliAttachOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      ![
        "--codex-executable",
        "--host",
        "--session-pid",
        "--thread-id",
        "--workspace-root",
      ].includes(name) ||
      value === undefined
    ) {
      throw new BridgeError("INVALID_CONFIG", `Unknown attach-cli argument: ${name}`);
    }
    index += 1;
    if (name === "--codex-executable") {
      options.codexExecutable = value;
    } else if (name === "--host") {
      options.host = value;
    } else if (name === "--thread-id") {
      options.threadId = value;
    } else if (name === "--workspace-root") {
      options.workspaceRoot = value;
    } else {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new BridgeError("INVALID_CONFIG", "--session-pid must be a positive integer");
      }
      options.sessionPid = pid;
    }
  }
  return options;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const attachArgs =
    args[0] === "attach-cli"
      ? args.slice(1)
      : isManagedExternalCliLauncher()
        ? args
        : null;
  if (attachArgs) {
    return await runExternalCliAttach(parseExternalCliAttachOptions(attachArgs));
  }
  if (isManagedAutomaticCliLauncher()) {
    const codexExecutable = await configuredCodexExecutable(true);
    assertExecutableIsNotShim(codexExecutable);
    if (args.length === 0) {
      const options = await automaticExternalCliAttachOptions();
      if (options) {
        return await runExternalCliAttach({
          ...options,
          codexExecutable,
        });
      }
    }
    return await passthrough(codexExecutable, args);
  }
  if (args[0] === "external-mcp") {
    return await runExternalMcpServer();
  }
  const mcpProxy = parseMcpProxyInvocation(args);
  const fallbackExecutable = await selectedCodexExecutable();
  assertExecutableIsNotShim(fallbackExecutable);
  const configPath = mcpProxy?.configPath ?? activeBridgeConfigPath();
  if (!configPath) {
    if (mcpProxy) {
      throw new BridgeError("INVALID_CONFIG", "Remote MCP relay has no active Bridge session");
    }
    if (!args.includes("app-server")) {
      return await passthrough(fallbackExecutable, args);
    }
  }

  const auditPath = bridgeAuditPath();
  const audit = new AuditLog(auditPath);
  if (configPath && process.env.CODEX_BRIDGE_SESSION_CONFIG) {
    await waitForSessionConfig(configPath);
  }
  const config = configPath ? await loadOptionalConfig(configPath, audit) : null;
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

  const controlDir = config ? bridgeControlDir() : process.cwd();
  if (config) {
    await mkdir(controlDir, { mode: 0o500, recursive: true });
    await chmodIfSupported(controlDir, 0o500);
  }
  let appServerArgs = [...args];
  let localMcpServers: string[] = [];
  let remoteMcpServers: string[] = [];
  let skippedMcpAccessServers: string[] = [];
  let mcpRoutingError: string | undefined;
  if (config) {
    try {
      const routing = await routeRemoteMcpServers({
        appServerArgs: args,
        codexExecutable,
        config,
        relay: currentShimRelayLaunch(configPath!),
      });
      appServerArgs = routing.appServerArgs;
      localMcpServers = routing.localServers;
      remoteMcpServers = routing.remoteServers;
      skippedMcpAccessServers = routing.skippedAccessServers;
    } catch (error) {
      mcpRoutingError = error instanceof Error ? error.message : String(error);
    }
    appServerArgs = withRemoteCorePolicy(appServerArgs);
  }
  await audit.write({
    operation: "shim.start",
    outcome: "started",
    hostId: config?.host ?? "local",
    workspaceRoot: config?.workspaceRoot ?? process.cwd(),
    details: {
      appServerArgs,
      bridgeConfigured: config !== null,
      controlDir,
      controlDirectory: {
        path: controlDir,
        role: config ? "control" : "workspace",
        target: "local",
      },
      localMcpServers,
      primaryRoot: config?.roots.find(
        (root) => root.target === "remote" && root.role === "primary",
      ) ?? null,
      remoteMcpAccess: config?.remoteMcpAccess ?? null,
      remoteMcpRouting: config?.remoteMcpRouting ?? "local",
      remoteMcpServers,
      skippedMcpAccessServers,
      ...(mcpRoutingError ? { mcpRoutingError } : {}),
    },
  });

  const proxy = new SharedAppServer({
    appServerArgs,
    appServerCwd: controlDir,
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
