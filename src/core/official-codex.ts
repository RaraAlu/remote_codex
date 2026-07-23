import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { BridgeError } from "./errors.js";

export const OFFICIAL_CODEX_EXTENSION_ID = "openai.chatgpt";

export interface OfficialCodexRuntime {
  source: "official-extension";
  executable: string;
  extensionVersion: string;
  codexVersion: string;
}

export function officialCodexExecutable(
  extensionPath: string,
  hostPlatform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (architecture !== "x64") {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      `The official Codex extension runtime is unsupported on ${hostPlatform}-${architecture}`,
    );
  }
  if (hostPlatform === "linux") {
    return posix.join(extensionPath, "bin", "linux-x86_64", "codex");
  }
  if (hostPlatform === "win32") {
    return win32.join(extensionPath, "bin", "windows-x86_64", "codex.exe");
  }
  throw new BridgeError(
    "PROTOCOL_MISMATCH",
    `The official Codex extension runtime is unsupported on ${hostPlatform}-${architecture}`,
  );
}

export function resolveOfficialCodexExecutable(
  extensionPath: string,
  options: {
    architecture?: string;
    fileExists?: (path: string) => boolean;
    hostPlatform?: NodeJS.Platform;
  } = {},
): string {
  const executable = officialCodexExecutable(
    extensionPath,
    options.hostPlatform,
    options.architecture,
  );
  if (!(options.fileExists ?? existsSync)(executable)) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      "The official Codex extension does not contain the expected bundled runtime",
      { executable },
    );
  }
  return executable;
}

export function validateBundledCodexProtocol(
  runtime: OfficialCodexRuntime,
  expectedCodexVersion: string | undefined,
): void {
  if (expectedCodexVersion && runtime.codexVersion !== expectedCodexVersion) {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      `Bundled Codex ${runtime.codexVersion} is incompatible with generated bridge protocol ${expectedCodexVersion}`,
    );
  }
}
