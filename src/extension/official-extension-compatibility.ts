import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const PATCH_KIND = "git-init-watcher-vscode-remote";
const METADATA_FILE = "git-init-watcher.json";
const BACKUP_FILE = "git-init-watcher.original.js";
const LOCK_FILE = ".git-init-watcher.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 50;

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const WORKING_TREE_HELPER_PATTERN = new RegExp(
  `async function (${IDENTIFIER})\\(t,e\\)\\{if\\(!t\\.isLocal\\|\\|${IDENTIFIER}\\(\\)\\)return t\\.startFileWatch\\(e\\);let r=${IDENTIFIER}\\(e\\.path\\);if\\(r==null\\)return t\\.startFileWatch\\(e\\);try\\{let n=${IDENTIFIER}\\.workspace\\.createFileSystemWatcher\\(new ${IDENTIFIER}\\.RelativePattern\\(r,"\\*\\*"\\)\\)`,
  "g",
);
const GIT_INIT_WATCH_PATTERN = new RegExp(
  `async startWatch\\((${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER})\\)\\{let (${IDENTIFIER})=await this\\.options\\.host\\.startFileWatch\\(\\{path:\\1,recursive:!1,renameEventHandling:"changed-path",` +
    'watchId:`git-init-\\$\\{crypto\\.randomUUID\\(\\)\\}`,onChange:\\2\\}\\);',
  "g",
);

function routedGitInitWatchPattern(helperName: string): RegExp {
  return new RegExp(
    `async startWatch\\((${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER}),(${IDENTIFIER})\\)\\{let (${IDENTIFIER})=await ${helperName}\\(this\\.options\\.host,\\{path:\\1,recursive:!1,renameEventHandling:"changed-path",` +
      'watchId:`git-init-\\$\\{crypto\\.randomUUID\\(\\)\\}`,onChange:\\2\\}\\);',
    "g",
  );
}

interface PatchMetadata {
  schemaVersion: 1;
  patchKind: typeof PATCH_KIND;
  extensionPath: string;
  extensionVersion: string | null;
  targetPath: string;
  originalSha256: string;
  patchedSha256: string;
  backupFile: typeof BACKUP_FILE;
}

export type OfficialExtensionCompatibilityStatus =
  | "not-applicable"
  | "unavailable"
  | "upstream-compatible"
  | "patched"
  | "already-patched"
  | "restored"
  | "already-restored"
  | "stale-cleaned"
  | "unsupported"
  | "conflict"
  | "nothing-to-restore";

export interface OfficialExtensionCompatibilityResult {
  status: OfficialExtensionCompatibilityStatus;
  changed: boolean;
  targetPath: string | null;
  extensionVersion: string | null;
  originalSha256?: string;
  patchedSha256?: string;
  detail?: string;
}

export interface OfficialExtensionCompatibilityOptions {
  extensionPath: string;
  extensionVersion: string | null;
  stateDirectory: string;
  hostPlatform?: NodeJS.Platform;
  remoteName?: string;
}

type SourceInspection =
  | { status: "patchable"; helperName: string; patchedSource: string }
  | { status: "compatible" }
  | { status: "unsupported"; detail: string };

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function matches(source: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

export function inspectOfficialExtensionSource(source: string): SourceInspection {
  const helperMatches = matches(source, WORKING_TREE_HELPER_PATTERN);
  if (helperMatches.length !== 1) {
    return {
      status: "unsupported",
      detail: `expected one VS Code working-tree watcher helper, found ${helperMatches.length}`,
    };
  }
  const helper = helperMatches[0];
  const helperName = helper?.[1];
  const helperIndex = helper?.index;
  if (!helperName || helperIndex === undefined) {
    return { status: "unsupported", detail: "working-tree watcher helper is malformed" };
  }
  const helperWindow = source.slice(helperIndex, helperIndex + 4_000);
  if (
    !helperWindow.includes('.uri.scheme==="vscode-remote"') ||
    !helperWindow.includes(".Uri.file(t)")
  ) {
    return {
      status: "unsupported",
      detail: "working-tree watcher helper does not map the active vscode-remote workspace",
    };
  }

  const directMatches = matches(source, GIT_INIT_WATCH_PATTERN);
  if (directMatches.length === 0) {
    const routedMatches = matches(source, routedGitInitWatchPattern(helperName));
    if (routedMatches.length === 1) {
      return { status: "compatible" };
    }
    return {
      status: "unsupported",
      detail: `expected one direct or VS Code-routed git-init watcher call, found ${routedMatches.length}`,
    };
  }
  if (directMatches.length !== 1) {
    return {
      status: "unsupported",
      detail: `expected one direct git-init watcher call, found ${directMatches.length}`,
    };
  }

  const direct = directMatches[0];
  const directSource = direct?.[0];
  const directIndex = direct?.index;
  if (!directSource || directIndex === undefined) {
    return { status: "unsupported", detail: "git-init watcher call is malformed" };
  }
  const routedSource = directSource.replace(
    "this.options.host.startFileWatch(",
    `${helperName}(this.options.host,`,
  );
  if (routedSource === directSource) {
    return { status: "unsupported", detail: "git-init watcher replacement did not apply" };
  }
  return {
    status: "patchable",
    helperName,
    patchedSource:
      source.slice(0, directIndex) +
      routedSource +
      source.slice(directIndex + directSource.length),
  };
}

function targetPath(extensionPath: string): string {
  return join(resolve(extensionPath), "out", "extension.js");
}

function metadataPath(stateDirectory: string): string {
  return join(stateDirectory, METADATA_FILE);
}

function backupPath(stateDirectory: string): string {
  return join(stateDirectory, BACKUP_FILE);
}

function isPatchMetadata(value: unknown): value is PatchMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PatchMetadata>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.patchKind === PATCH_KIND &&
    typeof candidate.extensionPath === "string" &&
    (typeof candidate.extensionVersion === "string" || candidate.extensionVersion === null) &&
    typeof candidate.targetPath === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.originalSha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(candidate.patchedSha256 ?? "") &&
    candidate.backupFile === BACKUP_FILE &&
    resolve(candidate.targetPath) === targetPath(candidate.extensionPath)
  );
}

async function loadMetadata(stateDirectory: string): Promise<PatchMetadata | null | "invalid"> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath(stateDirectory), "utf8"));
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

async function writeAtomic(path: string, content: string | Buffer, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeMetadata(stateDirectory: string, metadata: PatchMetadata): Promise<void> {
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

async function acquireLock(stateDirectory: string): Promise<{
  handle: FileHandle;
  path: string;
}> {
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
  throw new Error("Timed out waiting for the official extension compatibility lock");
}

async function withLock<T>(stateDirectory: string, task: () => Promise<T>): Promise<T> {
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

async function restoreMetadataTarget(
  stateDirectory: string,
  metadata: PatchMetadata,
): Promise<OfficialExtensionCompatibilityResult> {
  const backup = await readManagedBackup(stateDirectory, metadata);
  if (!backup) {
    return {
      status: "conflict",
      changed: false,
      targetPath: metadata.targetPath,
      extensionVersion: metadata.extensionVersion,
      detail: "managed backup is missing or its SHA-256 does not match",
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
        targetPath: metadata.targetPath,
        extensionVersion: metadata.extensionVersion,
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
      targetPath: metadata.targetPath,
      extensionVersion: metadata.extensionVersion,
      originalSha256: metadata.originalSha256,
      patchedSha256: metadata.patchedSha256,
    };
  }
  if (currentSha256 !== metadata.patchedSha256) {
    return {
      status: "conflict",
      changed: false,
      targetPath: metadata.targetPath,
      extensionVersion: metadata.extensionVersion,
      originalSha256: metadata.originalSha256,
      patchedSha256: metadata.patchedSha256,
      detail: "official extension asset changed after the managed patch; refusing to overwrite it",
    };
  }
  if (sha256(await readFile(metadata.targetPath)) !== metadata.patchedSha256) {
    return {
      status: "conflict",
      changed: false,
      targetPath: metadata.targetPath,
      extensionVersion: metadata.extensionVersion,
      originalSha256: metadata.originalSha256,
      patchedSha256: metadata.patchedSha256,
      detail: "official extension asset changed while preparing restoration",
    };
  }
  const targetMode = (await stat(metadata.targetPath)).mode;
  await writeAtomic(metadata.targetPath, backup, targetMode);
  if (sha256(await readFile(metadata.targetPath)) !== metadata.originalSha256) {
    throw new Error("Restored official extension asset failed SHA-256 verification");
  }
  await clearManagedState(stateDirectory);
  return {
    status: "restored",
    changed: true,
    targetPath: metadata.targetPath,
    extensionVersion: metadata.extensionVersion,
    originalSha256: metadata.originalSha256,
    patchedSha256: metadata.patchedSha256,
  };
}

async function reconcileLocked(
  options: OfficialExtensionCompatibilityOptions,
): Promise<OfficialExtensionCompatibilityResult> {
  const currentTarget = targetPath(options.extensionPath);
  const stored = await loadMetadata(options.stateDirectory);
  if (stored === "invalid") {
    return {
      status: "conflict",
      changed: false,
      targetPath: currentTarget,
      extensionVersion: options.extensionVersion,
      detail: "managed compatibility metadata is invalid",
    };
  }
  if (stored) {
    if (resolve(stored.extensionPath) !== resolve(options.extensionPath)) {
      if (!isSafeSiblingInstallation(stored.extensionPath, options.extensionPath)) {
        return {
          status: "conflict",
          changed: false,
          targetPath: currentTarget,
          extensionVersion: options.extensionVersion,
          detail: "previous patched extension is not a safe sibling of the active installation",
        };
      }
      const restored = await restoreMetadataTarget(options.stateDirectory, stored);
      if (restored.status === "conflict") {
        return restored;
      }
    } else {
      const backup = await readManagedBackup(options.stateDirectory, stored);
      if (!backup) {
        return {
          status: "conflict",
          changed: false,
          targetPath: currentTarget,
          extensionVersion: options.extensionVersion,
          detail: "managed backup is missing or its SHA-256 does not match",
        };
      }
      let current: Buffer;
      try {
        current = await readFile(currentTarget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await clearManagedState(options.stateDirectory);
          return {
            status: "unavailable",
            changed: false,
            targetPath: currentTarget,
            extensionVersion: options.extensionVersion,
            detail: "official extension entry asset is missing",
          };
        }
        throw error;
      }
      const currentSha256 = sha256(current);
      if (currentSha256 === stored.patchedSha256) {
        return {
          status: "already-patched",
          changed: false,
          targetPath: currentTarget,
          extensionVersion: options.extensionVersion,
          originalSha256: stored.originalSha256,
          patchedSha256: stored.patchedSha256,
        };
      }
      if (currentSha256 === stored.originalSha256) {
        const inspected = inspectOfficialExtensionSource(backup.toString("utf8"));
        if (inspected.status !== "patchable") {
          return {
            status: "conflict",
            changed: false,
            targetPath: currentTarget,
            extensionVersion: options.extensionVersion,
            detail: "managed original no longer produces the recorded compatibility patch",
          };
        }
        const patched = Buffer.from(inspected.patchedSource, "utf8");
        if (sha256(patched) !== stored.patchedSha256) {
          return {
            status: "conflict",
            changed: false,
            targetPath: currentTarget,
            extensionVersion: options.extensionVersion,
            detail: "managed patch output no longer matches its recorded SHA-256",
          };
        }
        if (sha256(await readFile(currentTarget)) !== stored.originalSha256) {
          return {
            status: "conflict",
            changed: false,
            targetPath: currentTarget,
            extensionVersion: options.extensionVersion,
            detail: "official extension asset changed while preparing to reapply the patch",
          };
        }
        const targetMode = (await stat(currentTarget)).mode;
        await writeAtomic(currentTarget, patched, targetMode);
        return {
          status: "patched",
          changed: true,
          targetPath: currentTarget,
          extensionVersion: options.extensionVersion,
          originalSha256: stored.originalSha256,
          patchedSha256: stored.patchedSha256,
          detail: "reapplied the managed patch after the original asset was restored",
        };
      }
      return {
        status: "conflict",
        changed: false,
        targetPath: currentTarget,
        extensionVersion: options.extensionVersion,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
        detail: "official extension asset changed after the managed patch; refusing to overwrite it",
      };
    }
  }

  let source: Buffer;
  try {
    source = await readFile(currentTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "unavailable",
        changed: false,
        targetPath: currentTarget,
        extensionVersion: options.extensionVersion,
        detail: "official extension entry asset is missing",
      };
    }
    throw error;
  }
  const inspected = inspectOfficialExtensionSource(source.toString("utf8"));
  if (inspected.status === "compatible") {
    return {
      status: "upstream-compatible",
      changed: false,
      targetPath: currentTarget,
      extensionVersion: options.extensionVersion,
    };
  }
  if (inspected.status === "unsupported") {
    return {
      status: "unsupported",
      changed: false,
      targetPath: currentTarget,
      extensionVersion: options.extensionVersion,
      detail: inspected.detail,
    };
  }

  const patched = Buffer.from(inspected.patchedSource, "utf8");
  const metadata: PatchMetadata = {
    schemaVersion: 1,
    patchKind: PATCH_KIND,
    extensionPath: resolve(options.extensionPath),
    extensionVersion: options.extensionVersion,
    targetPath: currentTarget,
    originalSha256: sha256(source),
    patchedSha256: sha256(patched),
    backupFile: BACKUP_FILE,
  };
  await writeAtomic(backupPath(options.stateDirectory), source, 0o600);
  await writeMetadata(options.stateDirectory, metadata);
  if (sha256(await readFile(currentTarget)) !== metadata.originalSha256) {
    await clearManagedState(options.stateDirectory);
    return {
      status: "conflict",
      changed: false,
      targetPath: currentTarget,
      extensionVersion: options.extensionVersion,
      originalSha256: metadata.originalSha256,
      patchedSha256: metadata.patchedSha256,
      detail: "official extension asset changed while preparing the managed patch",
    };
  }
  const targetMode = (await stat(currentTarget)).mode;
  try {
    await writeAtomic(currentTarget, patched, targetMode);
    if (sha256(await readFile(currentTarget)) !== metadata.patchedSha256) {
      throw new Error("Patched official extension asset failed SHA-256 verification");
    }
  } catch (error) {
    const afterFailure = await readFile(currentTarget).catch(() => null);
    if (afterFailure && sha256(afterFailure) === metadata.originalSha256) {
      await clearManagedState(options.stateDirectory);
    }
    throw error;
  }
  return {
    status: "patched",
    changed: true,
    targetPath: currentTarget,
    extensionVersion: options.extensionVersion,
    originalSha256: metadata.originalSha256,
    patchedSha256: metadata.patchedSha256,
  };
}

export async function reconcileOfficialExtensionCompatibility(
  options: OfficialExtensionCompatibilityOptions,
): Promise<OfficialExtensionCompatibilityResult> {
  if (
    (options.hostPlatform ?? process.platform) !== "win32" ||
    options.remoteName !== "ssh-remote"
  ) {
    return {
      status: "not-applicable",
      changed: false,
      targetPath: null,
      extensionVersion: options.extensionVersion,
    };
  }
  return await withLock(options.stateDirectory, () => reconcileLocked(options));
}

export async function restoreOfficialExtensionCompatibility(
  options: Omit<OfficialExtensionCompatibilityOptions, "remoteName">,
): Promise<OfficialExtensionCompatibilityResult> {
  return await withLock(options.stateDirectory, async () => {
    const stored = await loadMetadata(options.stateDirectory);
    if (stored === "invalid") {
      return {
        status: "conflict",
        changed: false,
        targetPath: targetPath(options.extensionPath),
        extensionVersion: options.extensionVersion,
        detail: "managed compatibility metadata is invalid",
      };
    }
    if (!stored) {
      return {
        status: "nothing-to-restore",
        changed: false,
        targetPath: null,
        extensionVersion: options.extensionVersion,
      };
    }
    if (resolve(stored.extensionPath) !== resolve(options.extensionPath)) {
      return {
        status: "conflict",
        changed: false,
        targetPath: stored.targetPath,
        extensionVersion: stored.extensionVersion,
        detail: "managed patch belongs to a different official extension installation",
      };
    }
    return await restoreMetadataTarget(options.stateDirectory, stored);
  });
}
