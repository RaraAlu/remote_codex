import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AuditLog } from "../core/audit-log.js";
import { loadBridgeConfig } from "../core/config-store.js";
import { BridgeError } from "../core/errors.js";
import {
  bridgeAuditPath,
  bridgeConfigPath,
  bridgeControlDir,
} from "../core/locations.js";
import type { BridgeConfig } from "../core/types.js";
import { ShimProxy } from "./proxy.js";

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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const controlDir = bridgeControlDir();
  const auditPath = bridgeAuditPath();
  const audit = new AuditLog(auditPath);
  await mkdir(controlDir, { mode: 0o500, recursive: true });
  await chmod(controlDir, 0o500);

  const config = await loadOptionalConfig(bridgeConfigPath(), audit);
  const codexExecutable =
    process.env.CODEX_BRIDGE_CODEX_EXECUTABLE || config?.codexExecutable || "codex";
  if (resolve(codexExecutable) === resolve(process.argv[1] ?? "")) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "CODEX_BRIDGE_CODEX_EXECUTABLE resolves to the shim itself",
    );
  }

  if (args[0] !== "app-server") {
    return await passthrough(codexExecutable, args);
  }

  await audit.write({
    operation: "shim.start",
    outcome: "started",
    hostId: config?.host,
    workspaceRoot: config?.workspaceRoot,
    details: {
      appServerArgs: args,
      bridgeConfigured: Boolean(config),
      controlDir,
    },
  });

  const proxy = new ShimProxy({
    appServerArgs: args,
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
