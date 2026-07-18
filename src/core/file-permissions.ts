import { chmod } from "node:fs/promises";
import { chmodSync, type PathLike } from "node:fs";

export async function chmodIfSupported(
  path: PathLike,
  mode: number,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (hostPlatform !== "win32") {
    await chmod(path, mode);
  }
}

export function chmodSyncIfSupported(
  path: PathLike,
  mode: number,
  hostPlatform: NodeJS.Platform = process.platform,
): void {
  if (hostPlatform !== "win32") {
    chmodSync(path, mode);
  }
}
