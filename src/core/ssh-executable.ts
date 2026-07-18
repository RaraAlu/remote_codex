import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, win32 } from "node:path";

export function sshExecutableCandidates(
  configured: string,
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
): string[] {
  const override = environment.CODEX_BRIDGE_SSH_EXECUTABLE;
  if (override) {
    return [override];
  }
  if (configured !== "ssh") {
    return [configured];
  }
  if (hostPlatform !== "win32") {
    return [configured];
  }

  const windowsRoot =
    environment.SystemRoot ||
    environment.SYSTEMROOT ||
    environment.WINDIR ||
    win32.join(environment.SystemDrive || "C:", "Windows");
  return [
    win32.join(windowsRoot, "System32", "OpenSSH", "ssh.exe"),
    win32.join(homedir(), "scoop", "apps", "openssh", "current", "ssh.exe"),
    "ssh.exe",
    "ssh",
  ];
}

export function resolveSshExecutable(
  configured: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    fileExists?: (path: string) => boolean;
    hostPlatform?: NodeJS.Platform;
  } = {},
): string {
  const fileExists = options.fileExists ?? existsSync;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const candidates = sshExecutableCandidates(
    configured,
    options.environment,
    hostPlatform,
  );
  return (
    candidates.find(
      (candidate) =>
        (hostPlatform === "win32" ? win32.isAbsolute(candidate) : isAbsolute(candidate)) &&
        fileExists(candidate),
    ) ??
    candidates.find((candidate) =>
      hostPlatform === "win32"
        ? !win32.isAbsolute(candidate)
        : !isAbsolute(candidate),
    ) ??
    configured
  );
}
