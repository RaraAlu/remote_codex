import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BridgeError } from "./errors.js";
import { chmodIfSupported } from "./file-permissions.js";
import { parseBridgeConfig } from "./config.js";
import type { BridgeConfig } from "./types.js";

export async function loadBridgeConfig(path: string): Promise<BridgeConfig> {
  try {
    const content = await readFile(path, "utf8");
    return parseBridgeConfig(JSON.parse(content));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new BridgeError("INVALID_CONFIG", `Bridge configuration does not exist: ${path}`);
    }
    if (error instanceof SyntaxError) {
      throw new BridgeError("INVALID_CONFIG", `Bridge configuration is not valid JSON: ${path}`);
    }
    throw error;
  }
}

export async function saveBridgeConfig(path: string, config: BridgeConfig): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmodIfSupported(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmodIfSupported(path, 0o600);
}
