import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { inspectCodexInlineMentionSource } from "./codex-inline-mention-patch.js";

const PATCH_KIND = "codex-inline-file-mention";
const METADATA_FILE = "inline-file-mention.json";
const BACKUP_FILE = "inline-file-mention.original.js";
const LOCK_FILE = ".inline-file-mention.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 50;

interface PatchMetadata {
  schemaVersion: 1;
  patchKind: typeof PATCH_KIND;
  extensionPath: string;
  extensionVersion: string | null;
  targetPath: string;
  targetRelativePath: string;
  originalSha256: string;
  patchedSha256: string;
  backupFile: typeof BACKUP_FILE;
}

export type CodexInlineMentionCompatibilityStatus =
  | "disabled"
  | "patched"
  | "already-patched"
  | "restored"
  | "already-restored"
  | "nothing-to-restore"
  | "stale-cleaned"
  | "unavailable"
  | "unsupported"
  | "conflict";

export interface CodexInlineMentionCompatibilityResult {
  status: CodexInlineMentionCompatibilityStatus;
  changed: boolean;
  extensionVersion: string | null;
  targetPath: string | null;
  originalSha256?: string;
  patchedSha256?: string;
  detail?: string;
}

export interface CodexInlineMentionCompatibilityOptions {
  extensionPath: string;
  extensionVersion: string | null;
  stateDirectory: string;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function metadataPath(stateDirectory: string): string {
  return join(stateDirectory, METADATA_FILE);
}

function backupPath(stateDirectory: string): string {
  return join(stateDirectory, BACKUP_FILE);
}

function isWithinExtension(extensionPath: string, targetPath: string): boolean {
  const root = resolve(extensionPath);
  const target = resolve(targetPath);
  return target.startsWith(`${root}${sep}`);
}

function isPatchMetadata(value: unknown): value is PatchMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PatchMetadata>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.patchKind !== PATCH_KIND ||
    typeof candidate.extensionPath !== "string" ||
    (typeof candidate.extensionVersion !== "string" &&
      candidate.extensionVersion !== null) ||
    typeof candidate.targetPath !== "string" ||
    typeof candidate.targetRelativePath !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.originalSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(candidate.patchedSha256 ?? "") ||
    candidate.backupFile !== BACKUP_FILE
  ) {
    return false;
  }
  const expected = resolve(candidate.extensionPath, candidate.targetRelativePath);
  return (
    resolve(candidate.targetPath) === expected &&
    isWithinExtension(candidate.extensionPath, expected) &&
    relative(resolve(candidate.extensionPath, "webview", "assets"), expected)
      .split(sep)
      .every((segment) => segment !== "..") &&
    expected.endsWith(".js")
  );
}

async function loadMetadata(
  stateDirectory: string,
): Promise<PatchMetadata | null | "invalid"> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(metadataPath(stateDirectory), "utf8"),
    );
    return isPatchMetadata(parsed) ? parsed : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return "invalid";
    }
    throw error;
  }
}

async function writeAtomic(
  path: string,
  content: string | Buffer,
  mode: number,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeMetadata(
  stateDirectory: string,
  metadata: PatchMetadata,
): Promise<void> {
  await writeAtomic(
    metadataPath(stateDirectory),
    `${JSON.stringify(metadata, null, 2)}\n`,
    0o600,
  );
}

async function clearManagedState(stateDirectory: string): Promise<void> {
  await Promise.all([
    rm(metadataPath(stateDirectory), { force: true }),
    rm(backupPath(stateDirectory), { force: true }),
  ]);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function acquireLock(
  stateDirectory: string,
): Promise<{ handle: FileHandle; path: string }> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, LOCK_FILE);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
        return { handle, path };
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(path);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("Timed out waiting for the Codex inline mention compatibility lock");
}

async function withLock<T>(
  stateDirectory: string,
  task: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(stateDirectory);
  try {
    return await task();
  } finally {
    try {
      await lock.handle.close();
    } finally {
      await rm(lock.path, { force: true });
    }
  }
}

async function readManagedBackup(
  stateDirectory: string,
  metadata: PatchMetadata,
): Promise<Buffer | null> {
  try {
    const backup = await readFile(backupPath(stateDirectory));
    return sha256(backup) === metadata.originalSha256 ? backup : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isSafeSiblingInstallation(previousPath: string, currentPath: string): boolean {
  const previous = resolve(previousPath);
  const current = resolve(currentPath);
  const officialName = (path: string): boolean =>
    basename(path).toLowerCase().startsWith("openai.chatgpt-");
  return (
    dirname(previous).toLowerCase() === dirname(current).toLowerCase() &&
    officialName(previous) &&
    officialName(current)
  );
}

async function discoverTarget(extensionPath: string): Promise<
  | { status: "patchable"; path: string; source: Buffer; patched: Buffer }
  | { status: "compatible"; path: string }
  | { status: "unavailable"; detail: string }
  | { status: "unsupported"; detail: string }
> {
  const assetsDirectory = resolve(extensionPath, "webview", "assets");
  let entries;
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "unavailable", detail: "official Codex Webview assets are missing" };
    }
    throw error;
  }
  const candidates: Array<
    | { status: "patchable"; path: string; source: Buffer; patched: Buffer }
    | { status: "compatible"; path: string }
  > = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    const path = join(assetsDirectory, entry.name);
    const source = await readFile(path);
    if (!source.includes(Buffer.from("add-context-file"))) {
      continue;
    }
    const inspected = inspectCodexInlineMentionSource(source.toString("utf8"));
    if (inspected.status === "patchable") {
      candidates.push({
        status: "patchable",
        path,
        source,
        patched: Buffer.from(inspected.patchedSource, "utf8"),
      });
    } else if (inspected.status === "compatible") {
      candidates.push({ status: "compatible", path });
    }
  }
  if (candidates.length !== 1) {
    return {
      status: "unsupported",
      detail: `expected one compatible Codex composer asset, found ${candidates.length}`,
    };
  }
  return candidates[0]!;
}

async function restoreMetadataTarget(
  stateDirectory: string,
  metadata: PatchMetadata,
): Promise<CodexInlineMentionCompatibilityResult> {
  const backup = await readManagedBackup(stateDirectory, metadata);
  if (!backup) {
    return {
      status: "conflict",
      changed: false,
      extensionVersion: metadata.extensionVersion,
      targetPath: metadata.targetPath,
      detail: "managed inline mention backup is missing or invalid",
    };
  }
  let current: Buffer;
  try {
    current = await readFile(metadata.targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await clearManagedState(stateDirectory);
      return {
        status: "stale-cleaned",
        changed: false,
        extensionVersion: metadata.extensionVersion,
        targetPath: metadata.targetPath,
      };
    }
    throw error;
  }
  const currentSha256 = sha256(current);
  if (currentSha256 === metadata.originalSha256) {
    await clearManagedState(stateDirectory);
    return {
      status: "already-restored",
      changed: false,
      extensionVersion: metadata.extensionVersion,
      targetPath: metadata.targetPath,
      originalSha256: metadata.originalSha256,
      patchedSha256: metadata.patchedSha256,
    };
  }
  if (currentSha256 !== metadata.patchedSha256) {
    return {
      status: "conflict",
      changed: false,
      extensionVersion: metadata.extensionVersion,
      targetPath: metadata.targetPath,
      originalSha256: metadata.originalSha256,
      patchedSha256: metadata.patchedSha256,
      detail: "official Codex Webview asset changed after the managed inline mention patch",
    };
  }
  const targetMode = (await stat(metadata.targetPath)).mode;
  await writeAtomic(metadata.targetPath, backup, targetMode);
  if (sha256(await readFile(metadata.targetPath)) !== metadata.originalSha256) {
    throw new Error("Restored official Codex Webview asset failed SHA-256 verification");
  }
  await clearManagedState(stateDirectory);
  return {
    status: "restored",
    changed: true,
    extensionVersion: metadata.extensionVersion,
    targetPath: metadata.targetPath,
    originalSha256: metadata.originalSha256,
    patchedSha256: metadata.patchedSha256,
  };
}

async function enableLocked(
  options: CodexInlineMentionCompatibilityOptions,
): Promise<CodexInlineMentionCompatibilityResult> {
  const stored = await loadMetadata(options.stateDirectory);
  if (stored === "invalid") {
    return {
      status: "conflict",
      changed: false,
      extensionVersion: options.extensionVersion,
      targetPath: null,
      detail: "managed inline mention metadata is invalid",
    };
  }
  if (stored) {
    if (resolve(stored.extensionPath) !== resolve(options.extensionPath)) {
      if (!isSafeSiblingInstallation(stored.extensionPath, options.extensionPath)) {
        return {
          status: "conflict",
          changed: false,
          extensionVersion: options.extensionVersion,
          targetPath: stored.targetPath,
          detail: "managed inline mention patch belongs to another extension installation",
        };
      }
      const restored = await restoreMetadataTarget(options.stateDirectory, stored);
      if (restored.status === "conflict") {
        return restored;
      }
      return await enableLocked(options);
    }

    const backup = await readManagedBackup(options.stateDirectory, stored);
    if (!backup) {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        detail: "managed inline mention backup is missing or invalid",
      };
    }
    const desiredInspection = inspectCodexInlineMentionSource(backup.toString("utf8"));
    if (desiredInspection.status !== "patchable") {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        detail: "managed original no longer produces an inline mention patch",
      };
    }
    const desiredPatched = Buffer.from(desiredInspection.patchedSource, "utf8");
    const desiredSha256 = sha256(desiredPatched);
    const current = await readFile(stored.targetPath);
    const currentSha256 = sha256(current);
    if (desiredSha256 !== stored.patchedSha256) {
      if (currentSha256 === stored.originalSha256) {
        await clearManagedState(options.stateDirectory);
      } else {
        const restored = await restoreMetadataTarget(options.stateDirectory, stored);
        if (restored.status !== "restored") {
          return restored;
        }
      }
      return await enableLocked(options);
    }
    if (currentSha256 === stored.patchedSha256) {
      return {
        status: "already-patched",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
      };
    }
    if (currentSha256 !== stored.originalSha256) {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
        detail: "official Codex Webview asset changed after the managed inline mention patch",
      };
    }
    const targetMode = (await stat(stored.targetPath)).mode;
    await writeAtomic(stored.targetPath, desiredPatched, targetMode);
    return {
      status: "patched",
      changed: true,
      extensionVersion: options.extensionVersion,
      targetPath: stored.targetPath,
      originalSha256: stored.originalSha256,
      patchedSha256: stored.patchedSha256,
      detail: "reapplied the managed inline mention patch",
    };
  }

  const discovered = await discoverTarget(options.extensionPath);
  if (discovered.status === "unavailable" || discovered.status === "unsupported") {
    return {
      status: discovered.status,
      changed: false,
      extensionVersion: options.extensionVersion,
      targetPath: null,
      detail: discovered.detail,
    };
  }
  if (discovered.status === "compatible") {
    return {
      status: "conflict",
      changed: false,
      extensionVersion: options.extensionVersion,
      targetPath: discovered.path,
      detail: "official Codex Webview contains an unmanaged inline mention patch",
    };
  }

  const extensionPath = resolve(options.extensionPath);
  const metadata: PatchMetadata = {
    schemaVersion: 1,
    patchKind: PATCH_KIND,
    extensionPath,
    extensionVersion: options.extensionVersion,
    targetPath: discovered.path,
    targetRelativePath: relative(extensionPath, discovered.path),
    originalSha256: sha256(discovered.source),
    patchedSha256: sha256(discovered.patched),
    backupFile: BACKUP_FILE,
  };
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  await writeAtomic(backupPath(options.stateDirectory), discovered.source, 0o600);
  await writeMetadata(options.stateDirectory, metadata);
  if (sha256(await readFile(discovered.path)) !== metadata.originalSha256) {
    await clearManagedState(options.stateDirectory);
    return {
      status: "conflict",
      changed: false,
      extensionVersion: options.extensionVersion,
      targetPath: discovered.path,
      detail: "official Codex Webview asset changed while preparing the inline mention patch",
    };
  }
  const targetMode = (await stat(discovered.path)).mode;
  try {
    await writeAtomic(discovered.path, discovered.patched, targetMode);
    if (sha256(await readFile(discovered.path)) !== metadata.patchedSha256) {
      throw new Error("Patched official Codex Webview asset failed SHA-256 verification");
    }
  } catch (error) {
    const current = await readFile(discovered.path).catch(() => null);
    if (current && sha256(current) === metadata.originalSha256) {
      await clearManagedState(options.stateDirectory);
    }
    throw error;
  }
  return {
    status: "patched",
    changed: true,
    extensionVersion: options.extensionVersion,
    targetPath: discovered.path,
    originalSha256: metadata.originalSha256,
    patchedSha256: metadata.patchedSha256,
  };
}

export async function enableCodexInlineMentionCompatibility(
  options: CodexInlineMentionCompatibilityOptions,
): Promise<CodexInlineMentionCompatibilityResult> {
  return await withLock(options.stateDirectory, () => enableLocked(options));
}

export async function restoreCodexInlineMentionCompatibility(
  options: CodexInlineMentionCompatibilityOptions,
): Promise<CodexInlineMentionCompatibilityResult> {
  return await withLock(options.stateDirectory, async () => {
    const stored = await loadMetadata(options.stateDirectory);
    if (stored === "invalid") {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: null,
        detail: "managed inline mention metadata is invalid",
      };
    }
    if (!stored) {
      return {
        status: "nothing-to-restore",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: null,
      };
    }
    if (
      resolve(stored.extensionPath) !== resolve(options.extensionPath) &&
      !isSafeSiblingInstallation(stored.extensionPath, options.extensionPath)
    ) {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: stored.extensionVersion,
        targetPath: stored.targetPath,
        detail: "managed inline mention patch belongs to another extension installation",
      };
    }
    return await restoreMetadataTarget(options.stateDirectory, stored);
  });
}

export async function inspectCodexInlineMentionCompatibility(
  options: CodexInlineMentionCompatibilityOptions,
): Promise<CodexInlineMentionCompatibilityResult> {
  return await withLock(options.stateDirectory, async () => {
    const stored = await loadMetadata(options.stateDirectory);
    if (stored === "invalid") {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: null,
        detail: "managed inline mention metadata is invalid",
      };
    }
    if (!stored) {
      const discovered = await discoverTarget(options.extensionPath);
      if (discovered.status === "patchable") {
        return {
          status: "disabled",
          changed: false,
          extensionVersion: options.extensionVersion,
          targetPath: discovered.path,
        };
      }
      return {
        status: discovered.status === "compatible" ? "conflict" : discovered.status,
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: discovered.status === "compatible" ? discovered.path : null,
        detail:
          discovered.status === "compatible"
            ? "official Codex Webview contains an unmanaged inline mention patch"
            : discovered.detail,
      };
    }
    if (resolve(stored.extensionPath) !== resolve(options.extensionPath)) {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        detail: "managed inline mention patch belongs to another extension installation",
      };
    }
    const backup = await readManagedBackup(options.stateDirectory, stored);
    if (!backup) {
      return {
        status: "conflict",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        detail: "managed inline mention backup is missing or invalid",
      };
    }
    const current = await readFile(stored.targetPath).catch(() => null);
    if (!current) {
      return {
        status: "unavailable",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        detail: "managed official Codex Webview asset is missing",
      };
    }
    const currentSha256 = sha256(current);
    if (currentSha256 === stored.patchedSha256) {
      return {
        status: "already-patched",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
      };
    }
    if (currentSha256 === stored.originalSha256) {
      return {
        status: "disabled",
        changed: false,
        extensionVersion: options.extensionVersion,
        targetPath: stored.targetPath,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
      };
    }
    return {
      status: "conflict",
      changed: false,
      extensionVersion: options.extensionVersion,
      targetPath: stored.targetPath,
      originalSha256: stored.originalSha256,
      patchedSha256: stored.patchedSha256,
      detail: "official Codex Webview asset changed after the managed inline mention patch",
    };
  });
}
