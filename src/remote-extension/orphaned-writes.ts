import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

const REGISTRY_PATTERN =
  /^codex-bridge-write-registry\.([1-9][0-9]*)\.([A-Za-z0-9]+)$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_REGISTRY_BYTES = 32 * 1024;

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function decodePath(value: string): string | null {
  if (!BASE64_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return decoded.startsWith("/") && !decoded.includes("\0") ? decoded : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

async function currentUserRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return (
      metadata.isFile() &&
      (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

export async function cleanupOrphanedWorkspaceWrites(
  workspaceRoots: readonly string[],
  options: {
    ownerAlive?: (pid: number) => boolean;
    registryDirectory?: string;
  } = {},
): Promise<number> {
  const registryDirectory = options.registryDirectory ?? tmpdir();
  const ownerAlive = options.ownerAlive ?? processIsAlive;
  const canonicalRoots = new Set(
    await Promise.all(workspaceRoots.map(async (root) => await realpath(root))),
  );
  let entries;
  try {
    entries = await readdir(registryDirectory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let cleaned = 0;
  for (const entry of entries) {
    const match = REGISTRY_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) {
      continue;
    }
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerAlive(ownerPid)) {
      continue;
    }
    const registryPath = join(registryDirectory, entry.name);
    try {
      const metadata = await lstat(registryPath);
      if (
        !metadata.isFile() ||
        metadata.size > MAX_REGISTRY_BYTES ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      ) {
        continue;
      }
      const [encodedRoot, encodedTemporaryPath, ...extra] = (
        await readFile(registryPath, "utf8")
      )
        .trimEnd()
        .split("\n");
      if (!encodedRoot || !encodedTemporaryPath || extra.length > 0) {
        continue;
      }
      const recordedRoot = decodePath(encodedRoot);
      const temporaryPath = decodePath(encodedTemporaryPath);
      if (!recordedRoot || !temporaryPath) {
        continue;
      }
      const canonicalRoot = await realpath(recordedRoot);
      const canonicalParent = await realpath(dirname(temporaryPath));
      if (
        !canonicalRoots.has(canonicalRoot) ||
        !isPathInside(canonicalRoot, canonicalParent) ||
        basename(temporaryPath) !==
          `.codex-bridge-write.${ownerPid}.${match[2]}`
      ) {
        continue;
      }
      if (await currentUserRegularFile(temporaryPath)) {
        await rm(temporaryPath, { force: true });
      }
      await rm(registryPath, { force: true });
      cleaned += 1;
    } catch {
      // Leave malformed or concurrently changing records untouched.
    }
  }
  return cleaned;
}
