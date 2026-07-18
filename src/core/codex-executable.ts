import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function windowsCodexPackagePath(
  appData: string,
  architecture: string,
): string | undefined {
  const target: readonly [string, string] | null =
    architecture === "arm64"
      ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"]
      : architecture === "x64"
        ? ["codex-win32-x64", "x86_64-pc-windows-msvc"]
        : null;
  if (!target) {
    return undefined;
  }
  const [packageName, rustTarget] = target;
  return win32.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    packageName,
    "vendor",
    rustTarget,
    "bin",
    "codex.exe",
  );
}

export function codexExecutableCandidates(
  configured: string,
  homeDirectory = homedir(),
  hostPlatform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  architecture: string = process.arch,
  additionalCandidates: readonly string[] = [],
): string[] {
  if (configured !== "codex") {
    return [configured];
  }

  if (hostPlatform === "win32") {
    const appData =
      environment.APPDATA || win32.join(homeDirectory, "AppData", "Roaming");
    return unique([
      windowsCodexPackagePath(appData, architecture),
      win32.join(homeDirectory, ".local", "bin", "codex.exe"),
      ...additionalCandidates,
      "codex.exe",
      "codex",
    ]);
  }

  return unique([
    configured,
    posix.join(homeDirectory, ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    ...additionalCandidates,
  ]);
}

export function resolveCodexExecutable(
  configured: string,
  options: {
    additionalCandidates?: readonly string[];
    architecture?: string;
    environment?: NodeJS.ProcessEnv;
    fileExists?: (path: string) => boolean;
    homeDirectory?: string;
    hostPlatform?: NodeJS.Platform;
  } = {},
): string {
  const fileExists = options.fileExists ?? existsSync;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const candidates = codexExecutableCandidates(
    configured,
    options.homeDirectory,
    hostPlatform,
    options.environment,
    options.architecture,
    options.additionalCandidates,
  );
  return (
    candidates.find(
      (candidate) =>
        (hostPlatform === "win32" ? win32.isAbsolute(candidate) : posix.isAbsolute(candidate)) &&
        fileExists(candidate),
    ) ??
    candidates.find((candidate) =>
      hostPlatform === "win32"
        ? !win32.isAbsolute(candidate)
        : !posix.isAbsolute(candidate),
    ) ??
    configured
  );
}
