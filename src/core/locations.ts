import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export function bridgeConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  if (environment.CODEX_BRIDGE_CONFIG) {
    return environment.CODEX_BRIDGE_CONFIG;
  }
  if (environment.XDG_CONFIG_HOME) {
    return pathApi.join(environment.XDG_CONFIG_HOME, "codex-remote-bridge", "config.json");
  }
  return hostPlatform === "win32"
    ? win32.join(
        environment.APPDATA || win32.join(homeDirectory, "AppData", "Roaming"),
        "codex-remote-bridge",
        "config.json",
      )
    : posix.join(homeDirectory, ".config", "codex-remote-bridge", "config.json");
}

export function bridgeStateDir(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (environment.CODEX_BRIDGE_STATE_DIR) {
    return environment.CODEX_BRIDGE_STATE_DIR;
  }
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  const stateHome =
    environment.XDG_STATE_HOME ||
    (hostPlatform === "win32"
      ? environment.LOCALAPPDATA || win32.join(homeDirectory, "AppData", "Local")
      : posix.join(homeDirectory, ".local", "state"));
  return pathApi.join(stateHome, "codex-remote-bridge");
}

export function bridgeSessionConfigPath(
  extensionHostPid = process.pid,
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "sessions",
    `${extensionHostPid}.json`,
  );
}

export function activeBridgeConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return environment.CODEX_BRIDGE_SESSION_CONFIG || environment.CODEX_BRIDGE_CONFIG || null;
}

export function bridgeAuditPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeStateDir(environment), "audit.jsonl");
}

export function officialCodexRuntimePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeStateDir(environment), "official-codex-runtime.json");
}

export function officialExtensionCompatibilityDir(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "official-extension-compatibility",
  );
}

export function workbenchDropCompatibilityDir(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "workbench-drop-compatibility",
  );
}

export function codexInlineMentionCompatibilityDir(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "codex-inline-mention-compatibility",
  );
}

export function bridgeControlDir(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "control",
  );
}

export function bridgeRemoteControlDir(
  host: string,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  const workspaceId = createHash("sha256")
    .update(host)
    .update("\0")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 32);
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "remote-control",
    workspaceId,
  );
}

export function bridgeShimRuntimeStatusPath(
  host: string,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  const workspaceId = createHash("sha256")
    .update(host)
    .update("\0")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 32);
  return pathApi.join(
    bridgeStateDir(environment, hostPlatform, homeDirectory),
    "shim-runtime",
    `${workspaceId}.json`,
  );
}

export function bridgeExternalCliDir(environment: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeStateDir(environment), "external-cli");
}

export function bridgeExternalCliIntegrationPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(bridgeExternalCliDir(environment), "integration.json");
}

export function bridgeExternalCliSessionPath(
  shimPid = process.pid,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(bridgeExternalCliDir(environment), `${shimPid}.json`);
}

export function bridgeExternalCliTokenPath(
  shimPid = process.pid,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(bridgeExternalCliDir(environment), `${shimPid}.token`);
}

export function bridgeUpstreamTokenPath(
  shimPid = process.pid,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(bridgeExternalCliDir(environment), `${shimPid}.upstream.token`);
}
