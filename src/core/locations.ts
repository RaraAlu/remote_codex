import { homedir } from "node:os";
import { join } from "node:path";

export function bridgeConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return environment.CODEX_BRIDGE_CONFIG || join(configHome, "codex-remote-bridge", "config.json");
}

export function bridgeStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const stateHome = environment.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return environment.CODEX_BRIDGE_STATE_DIR || join(stateHome, "codex-remote-bridge");
}

export function bridgeAuditPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeStateDir(environment), "audit.jsonl");
}

export function bridgeControlDir(environment: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeStateDir(environment), "control");
}
