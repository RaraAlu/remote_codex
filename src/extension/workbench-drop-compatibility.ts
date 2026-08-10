import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectWorkbenchDropSource } from "./workbench-drop-patch.js";

const execFileAsync = promisify(execFile);
const PATCH_KIND = "codex-workbench-drop-surface";
const METADATA_FILE = "workbench-drop.json";
const BACKUP_FILE = "workbench.original.js";
const PATCHED_FILE = "workbench.patched.js";
const PRODUCT_BACKUP_FILE = "product.original.json";
const PRODUCT_PATCHED_FILE = "product.patched.json";
const WORKBENCH_CHECKSUM_KEY = "vs/workbench/workbench.desktop.main.js";
const LOCK_FILE = ".workbench-drop.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 50;

interface PatchMetadata {
  schemaVersion: 1;
  patchKind: typeof PATCH_KIND;
  appRoot: string;
  targetPath: string;
  originalSha256: string;
  patchedSha256: string;
  productPath: string;
  productOriginalSha256: string;
  productPatchedSha256: string;
  backupFile: typeof BACKUP_FILE;
  patchedFile: typeof PATCHED_FILE;
  productBackupFile: typeof PRODUCT_BACKUP_FILE;
  productPatchedFile: typeof PRODUCT_PATCHED_FILE;
}

export interface WorkbenchAssetReplacement {
  expectedSha256: string;
  mode: number;
  replacementSha256: string;
  sourcePath: string;
  targetPath: string;
}

export type WorkbenchAssetReplacer = (
  replacement: WorkbenchAssetReplacement,
) => Promise<void>;

export type WorkbenchDropCompatibilityStatus =
  | "disabled"
  | "patched"
  | "already-patched"
  | "restored"
  | "already-restored"
  | "nothing-to-restore"
  | "unavailable"
  | "unsupported"
  | "conflict";

export interface WorkbenchDropCompatibilityResult {
  status: WorkbenchDropCompatibilityStatus;
  changed: boolean;
  targetPath: string;
  originalSha256?: string;
  patchedSha256?: string;
  productPath?: string;
  productOriginalSha256?: string;
  productPatchedSha256?: string;
  detail?: string;
}

export interface WorkbenchDropCompatibilityOptions {
  appRoot: string;
  stateDirectory: string;
  replaceTarget?: WorkbenchAssetReplacer;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function checksum(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
}

export function workbenchDropTargetPath(appRoot: string): string {
  return join(
    resolve(appRoot),
    "out",
    "vs",
    "workbench",
    "workbench.desktop.main.js",
  );
}

export function workbenchProductPath(appRoot: string): string {
  return join(resolve(appRoot), "product.json");
}

function metadataPath(stateDirectory: string): string {
  return join(stateDirectory, METADATA_FILE);
}

function backupPath(stateDirectory: string): string {
  return join(stateDirectory, BACKUP_FILE);
}

function patchedPath(stateDirectory: string): string {
  return join(stateDirectory, PATCHED_FILE);
}

function productBackupPath(stateDirectory: string): string {
  return join(stateDirectory, PRODUCT_BACKUP_FILE);
}

function productPatchedPath(stateDirectory: string): string {
  return join(stateDirectory, PRODUCT_PATCHED_FILE);
}

function isPatchMetadata(value: unknown): value is PatchMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PatchMetadata>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.patchKind === PATCH_KIND &&
    typeof candidate.appRoot === "string" &&
    typeof candidate.targetPath === "string" &&
    resolve(candidate.targetPath) === workbenchDropTargetPath(candidate.appRoot) &&
    typeof candidate.productPath === "string" &&
    resolve(candidate.productPath) === workbenchProductPath(candidate.appRoot) &&
    /^[0-9a-f]{64}$/.test(candidate.originalSha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(candidate.patchedSha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(candidate.productOriginalSha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(candidate.productPatchedSha256 ?? "") &&
    candidate.backupFile === BACKUP_FILE &&
    candidate.patchedFile === PATCHED_FILE &&
    candidate.productBackupFile === PRODUCT_BACKUP_FILE &&
    candidate.productPatchedFile === PRODUCT_PATCHED_FILE
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
    rm(patchedPath(stateDirectory), { force: true }),
    rm(productBackupPath(stateDirectory), { force: true }),
    rm(productPatchedPath(stateDirectory), { force: true }),
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchProductChecksum(
  productSource: Buffer,
  originalWorkbench: Buffer,
  patchedWorkbench: Buffer,
): Buffer | { detail: string } {
  let product: unknown;
  try {
    product = JSON.parse(productSource.toString("utf8"));
  } catch {
    return { detail: "VS Code product metadata is not valid JSON" };
  }
  const checksums =
    product && typeof product === "object"
      ? (product as { checksums?: unknown }).checksums
      : undefined;
  const current =
    checksums && typeof checksums === "object"
      ? (checksums as Record<string, unknown>)[WORKBENCH_CHECKSUM_KEY]
      : undefined;
  const expected = checksum(originalWorkbench);
  if (current !== expected) {
    return {
      detail: "VS Code product metadata does not match the current Workbench SHA-256 checksum",
    };
  }
  const source = productSource.toString("utf8");
  const oldValue = JSON.stringify(expected);
  const pattern = new RegExp(
    `("${escapeRegExp(WORKBENCH_CHECKSUM_KEY)}"\\s*:\\s*)${escapeRegExp(oldValue)}`,
    "g",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    return { detail: `expected one Workbench checksum entry, found ${matches.length}` };
  }
  const patched = source.replace(pattern, `$1${JSON.stringify(checksum(patchedWorkbench))}`);
  return Buffer.from(patched, "utf8");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function acquireLock(stateDirectory: string): Promise<{ handle: FileHandle; path: string }> {
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
  throw new Error("Timed out waiting for the Workbench drop compatibility lock");
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

async function readManagedFile(path: string, expectedSha256: string): Promise<Buffer | null> {
  try {
    const content = await readFile(path);
    return sha256(content) === expectedSha256 ? content : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function replaceWorkbenchAsset(
  replacement: WorkbenchAssetReplacement,
): Promise<void> {
  const replacementContent = await readFile(replacement.sourcePath);
  if (sha256(replacementContent) !== replacement.replacementSha256) {
    throw new Error("Staged Workbench replacement failed SHA-256 verification");
  }
  if (sha256(await readFile(replacement.targetPath)) !== replacement.expectedSha256) {
    throw new Error("Workbench asset changed before replacement");
  }
  const temporary = join(
    dirname(replacement.targetPath),
    `.codex-remote-bridge.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(replacement.sourcePath, temporary);
    await chmod(temporary, replacement.mode & 0o7777);
    if (sha256(await readFile(replacement.targetPath)) !== replacement.expectedSha256) {
      throw new Error("Workbench asset changed while preparing replacement");
    }
    await rename(temporary, replacement.targetPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

const PRIVILEGED_REPLACE_SCRIPT = [
  "set -eu",
  'expected="$1"',
  'replacement="$2"',
  'mode="$3"',
  'source_path="$4"',
  'target_path="$5"',
  'target_dir=$(/usr/bin/dirname -- "$target_path")',
  'temporary=$(/usr/bin/mktemp "$target_dir/.codex-remote-bridge.XXXXXX")',
  'trap \'/usr/bin/rm -f -- "$temporary"\' EXIT HUP INT TERM',
  '/usr/bin/install -m "$mode" -- "$source_path" "$temporary"',
  'replacement_actual=$(/usr/bin/sha256sum -- "$temporary")',
  'replacement_actual="${replacement_actual%% *}"',
  '[ "$replacement_actual" = "$replacement" ] || exit 71',
  'current_actual=$(/usr/bin/sha256sum -- "$target_path")',
  'current_actual="${current_actual%% *}"',
  '[ "$current_actual" = "$expected" ] || exit 72',
  '/usr/bin/mv -f -- "$temporary" "$target_path"',
  "trap - EXIT HUP INT TERM",
].join("\n");

export async function replaceWorkbenchAssetWithPkexec(
  replacement: WorkbenchAssetReplacement,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("Elevated Workbench replacement is currently available only on Linux");
  }
  await execFileAsync("/usr/bin/pkexec", privilegedWorkbenchReplacementArguments(replacement), {
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
}

export function privilegedWorkbenchReplacementArguments(
  replacement: WorkbenchAssetReplacement,
): string[] {
  return [
    "/bin/sh",
    "-c",
    PRIVILEGED_REPLACE_SCRIPT,
    "codex-remote-bridge",
    replacement.expectedSha256,
    replacement.replacementSha256,
    (replacement.mode & 0o7777).toString(8),
    replacement.sourcePath,
    replacement.targetPath,
  ];
}

export async function workbenchDropTargetNeedsElevation(appRoot: string): Promise<boolean> {
  const target = workbenchDropTargetPath(appRoot);
  const product = workbenchProductPath(appRoot);
  try {
    await Promise.all([
      access(target, constants.W_OK),
      access(dirname(target), constants.W_OK),
      access(product, constants.W_OK),
      access(dirname(product), constants.W_OK),
    ]);
    return false;
  } catch {
    return true;
  }
}

async function replaceAndVerify(
  options: WorkbenchDropCompatibilityOptions,
  replacement: WorkbenchAssetReplacement,
): Promise<void> {
  await (options.replaceTarget ?? replaceWorkbenchAsset)(replacement);
  if (sha256(await readFile(replacement.targetPath)) !== replacement.replacementSha256) {
    throw new Error("Replaced Workbench asset failed SHA-256 verification");
  }
}

async function enableLocked(
  options: WorkbenchDropCompatibilityOptions,
): Promise<WorkbenchDropCompatibilityResult> {
  const targetPath = workbenchDropTargetPath(options.appRoot);
  const productPath = workbenchProductPath(options.appRoot);
  const stored = await loadMetadata(options.stateDirectory);
  if (stored === "invalid") {
    return {
      status: "conflict",
      changed: false,
      targetPath,
      productPath,
      detail: "managed Workbench drop metadata is invalid",
    };
  }
  if (stored) {
    if (resolve(stored.appRoot) !== resolve(options.appRoot)) {
      return {
        status: "conflict",
        changed: false,
        targetPath,
        productPath,
        detail: "managed Workbench drop state belongs to another VS Code installation",
      };
    }
    const [original, patched, originalProduct, patchedProduct, current, currentProduct] =
      await Promise.all([
      readManagedFile(backupPath(options.stateDirectory), stored.originalSha256),
      readManagedFile(patchedPath(options.stateDirectory), stored.patchedSha256),
      readManagedFile(
        productBackupPath(options.stateDirectory),
        stored.productOriginalSha256,
      ),
      readManagedFile(
        productPatchedPath(options.stateDirectory),
        stored.productPatchedSha256,
      ),
      readFile(targetPath),
      readFile(productPath),
    ]);
    if (!original || !patched || !originalProduct || !patchedProduct) {
      return {
        status: "conflict",
        changed: false,
        targetPath,
        productPath,
        detail: "managed Workbench or product backup/staged patch is missing or invalid",
      };
    }
    const desiredInspection = inspectWorkbenchDropSource(original.toString("utf8"));
    if (desiredInspection.status !== "patchable") {
      return {
        status: "conflict",
        changed: false,
        targetPath,
        productPath,
        detail: "managed Workbench original no longer produces a compatibility patch",
      };
    }
    const desiredPatched = Buffer.from(desiredInspection.patchedSource, "utf8");
    const desiredProduct = patchProductChecksum(originalProduct, original, desiredPatched);
    if (!Buffer.isBuffer(desiredProduct)) {
      return {
        status: "conflict",
        changed: false,
        targetPath,
        productPath,
        detail: desiredProduct.detail,
      };
    }
    if (
      sha256(desiredPatched) !== stored.patchedSha256 ||
      sha256(desiredProduct) !== stored.productPatchedSha256
    ) {
      const restored = await restoreLocked(options);
      if (restored.status !== "restored" && restored.status !== "already-restored") {
        return restored;
      }
      return await enableLocked(options);
    }
    const currentSha256 = sha256(current);
    const currentProductSha256 = sha256(currentProduct);
    if (
      currentSha256 === stored.patchedSha256 &&
      currentProductSha256 === stored.productPatchedSha256
    ) {
      return {
        status: "already-patched",
        changed: false,
        targetPath,
        productPath,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
        productOriginalSha256: stored.productOriginalSha256,
        productPatchedSha256: stored.productPatchedSha256,
      };
    }
    if (
      ![stored.originalSha256, stored.patchedSha256].includes(currentSha256) ||
      ![stored.productOriginalSha256, stored.productPatchedSha256].includes(
        currentProductSha256,
      )
    ) {
      return {
        status: "conflict",
        changed: false,
        targetPath,
        productPath,
        originalSha256: stored.originalSha256,
        patchedSha256: stored.patchedSha256,
        productOriginalSha256: stored.productOriginalSha256,
        productPatchedSha256: stored.productPatchedSha256,
        detail: "Workbench or product asset changed after the managed patch; refusing to overwrite it",
      };
    }
    if (currentProductSha256 === stored.productOriginalSha256) {
      await replaceAndVerify(options, {
        expectedSha256: stored.productOriginalSha256,
        mode: (await stat(productPath)).mode,
        replacementSha256: stored.productPatchedSha256,
        sourcePath: productPatchedPath(options.stateDirectory),
        targetPath: productPath,
      });
    }
    if (currentSha256 === stored.originalSha256) {
      await replaceAndVerify(options, {
        expectedSha256: stored.originalSha256,
        mode: (await stat(targetPath)).mode,
        replacementSha256: stored.patchedSha256,
        sourcePath: patchedPath(options.stateDirectory),
        targetPath,
      });
    }
    return {
      status: "patched",
      changed: true,
      targetPath,
      productPath,
      originalSha256: stored.originalSha256,
      patchedSha256: stored.patchedSha256,
      productOriginalSha256: stored.productOriginalSha256,
      productPatchedSha256: stored.productPatchedSha256,
      detail: "reapplied the managed Workbench drop patch",
    };
  }

  let source: Buffer;
  try {
    source = await readFile(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "unavailable",
        changed: false,
        targetPath,
        productPath,
        detail: "VS Code Workbench entry asset is missing",
      };
    }
    throw error;
  }
  const inspected = inspectWorkbenchDropSource(source.toString("utf8"));
  if (inspected.status === "compatible") {
    return {
      status: "conflict",
      changed: false,
      targetPath,
      productPath,
      detail: "Workbench contains a drop patch without matching Bridge restore metadata",
    };
  }
  if (inspected.status === "unsupported") {
    return {
      status: "unsupported",
      changed: false,
      targetPath,
      productPath,
      detail: inspected.detail,
    };
  }

  const patched = Buffer.from(inspected.patchedSource, "utf8");
  let productSource: Buffer;
  try {
    productSource = await readFile(productPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "unavailable",
        changed: false,
        targetPath,
        productPath,
        detail: "VS Code product metadata is missing",
      };
    }
    throw error;
  }
  const patchedProduct = patchProductChecksum(productSource, source, patched);
  if (!Buffer.isBuffer(patchedProduct)) {
    return {
      status: "unsupported",
      changed: false,
      targetPath,
      productPath,
      detail: patchedProduct.detail,
    };
  }
  const metadata: PatchMetadata = {
    schemaVersion: 1,
    patchKind: PATCH_KIND,
    appRoot: resolve(options.appRoot),
    targetPath,
    originalSha256: sha256(source),
    patchedSha256: sha256(patched),
    productPath,
    productOriginalSha256: sha256(productSource),
    productPatchedSha256: sha256(patchedProduct),
    backupFile: BACKUP_FILE,
    patchedFile: PATCHED_FILE,
    productBackupFile: PRODUCT_BACKUP_FILE,
    productPatchedFile: PRODUCT_PATCHED_FILE,
  };
  await Promise.all([
    writeAtomic(backupPath(options.stateDirectory), source, 0o600),
    writeAtomic(patchedPath(options.stateDirectory), patched, 0o600),
    writeAtomic(productBackupPath(options.stateDirectory), productSource, 0o600),
    writeAtomic(productPatchedPath(options.stateDirectory), patchedProduct, 0o600),
  ]);
  await writeMetadata(options.stateDirectory, metadata);
  try {
    await replaceAndVerify(options, {
      expectedSha256: metadata.productOriginalSha256,
      mode: (await stat(productPath)).mode,
      replacementSha256: metadata.productPatchedSha256,
      sourcePath: productPatchedPath(options.stateDirectory),
      targetPath: productPath,
    });
    await replaceAndVerify(options, {
      expectedSha256: metadata.originalSha256,
      mode: (await stat(targetPath)).mode,
      replacementSha256: metadata.patchedSha256,
      sourcePath: patchedPath(options.stateDirectory),
      targetPath,
    });
  } catch (error) {
    let [afterFailure, productAfterFailure] = await Promise.all([
      readFile(targetPath).catch(() => null),
      readFile(productPath).catch(() => null),
    ]);
    try {
      if (afterFailure && sha256(afterFailure) === metadata.patchedSha256) {
        await replaceAndVerify(options, {
          expectedSha256: metadata.patchedSha256,
          mode: (await stat(targetPath)).mode,
          replacementSha256: metadata.originalSha256,
          sourcePath: backupPath(options.stateDirectory),
          targetPath,
        });
      }
      if (
        productAfterFailure &&
        sha256(productAfterFailure) === metadata.productPatchedSha256
      ) {
        await replaceAndVerify(options, {
          expectedSha256: metadata.productPatchedSha256,
          mode: (await stat(productPath)).mode,
          replacementSha256: metadata.productOriginalSha256,
          sourcePath: productBackupPath(options.stateDirectory),
          targetPath: productPath,
        });
      }
      [afterFailure, productAfterFailure] = await Promise.all([
        readFile(targetPath).catch(() => null),
        readFile(productPath).catch(() => null),
      ]);
    } catch (rollbackError) {
      throw new Error(
        `Workbench drop patch failed and rollback did not complete: ${String(rollbackError)}`,
        { cause: error },
      );
    }
    if (
      afterFailure &&
      productAfterFailure &&
      sha256(afterFailure) === metadata.originalSha256 &&
      sha256(productAfterFailure) === metadata.productOriginalSha256
    ) {
      await clearManagedState(options.stateDirectory);
    }
    throw error;
  }
  return {
    status: "patched",
    changed: true,
    targetPath,
    productPath,
    originalSha256: metadata.originalSha256,
    patchedSha256: metadata.patchedSha256,
    productOriginalSha256: metadata.productOriginalSha256,
    productPatchedSha256: metadata.productPatchedSha256,
  };
}

export async function enableWorkbenchDropCompatibility(
  options: WorkbenchDropCompatibilityOptions,
): Promise<WorkbenchDropCompatibilityResult> {
  return await withLock(options.stateDirectory, () => enableLocked(options));
}

async function restoreLocked(
  options: WorkbenchDropCompatibilityOptions,
): Promise<WorkbenchDropCompatibilityResult> {
  const targetPath = workbenchDropTargetPath(options.appRoot);
  const productPath = workbenchProductPath(options.appRoot);
  const stored = await loadMetadata(options.stateDirectory);
  if (stored === "invalid") {
    return {
      status: "conflict",
      changed: false,
      targetPath,
      productPath,
      detail: "managed Workbench drop metadata is invalid",
    };
  }
  if (!stored) {
    return { status: "nothing-to-restore", changed: false, targetPath, productPath };
  }
  if (resolve(stored.appRoot) !== resolve(options.appRoot)) {
    return {
      status: "conflict",
      changed: false,
      targetPath: stored.targetPath,
      productPath: stored.productPath,
      detail: "managed Workbench drop state belongs to another VS Code installation",
    };
  }
  const [original, originalProduct] = await Promise.all([
    readManagedFile(backupPath(options.stateDirectory), stored.originalSha256),
    readManagedFile(
      productBackupPath(options.stateDirectory),
      stored.productOriginalSha256,
    ),
  ]);
  if (!original || !originalProduct) {
    return {
      status: "conflict",
      changed: false,
      targetPath,
      productPath,
      detail: "managed Workbench or product backup is missing or invalid",
    };
  }
  const [currentSha256, currentProductSha256] = await Promise.all([
    readFile(targetPath).then(sha256),
    readFile(productPath).then(sha256),
  ]);
  if (
    currentSha256 === stored.originalSha256 &&
    currentProductSha256 === stored.productOriginalSha256
  ) {
    await clearManagedState(options.stateDirectory);
    return {
      status: "already-restored",
      changed: false,
      targetPath,
      productPath,
      originalSha256: stored.originalSha256,
      patchedSha256: stored.patchedSha256,
      productOriginalSha256: stored.productOriginalSha256,
      productPatchedSha256: stored.productPatchedSha256,
    };
  }
  if (
    ![stored.originalSha256, stored.patchedSha256].includes(currentSha256) ||
    ![stored.productOriginalSha256, stored.productPatchedSha256].includes(
      currentProductSha256,
    )
  ) {
    return {
      status: "conflict",
      changed: false,
      targetPath,
      productPath,
      originalSha256: stored.originalSha256,
      patchedSha256: stored.patchedSha256,
      productOriginalSha256: stored.productOriginalSha256,
      productPatchedSha256: stored.productPatchedSha256,
      detail: "Workbench or product asset changed after the managed patch; refusing to overwrite it",
    };
  }
  if (currentSha256 === stored.patchedSha256) {
    await replaceAndVerify(options, {
      expectedSha256: stored.patchedSha256,
      mode: (await stat(targetPath)).mode,
      replacementSha256: stored.originalSha256,
      sourcePath: backupPath(options.stateDirectory),
      targetPath,
    });
  }
  if (currentProductSha256 === stored.productPatchedSha256) {
    await replaceAndVerify(options, {
      expectedSha256: stored.productPatchedSha256,
      mode: (await stat(productPath)).mode,
      replacementSha256: stored.productOriginalSha256,
      sourcePath: productBackupPath(options.stateDirectory),
      targetPath: productPath,
    });
  }
  await clearManagedState(options.stateDirectory);
  return {
    status: "restored",
    changed: true,
    targetPath,
    productPath,
    originalSha256: stored.originalSha256,
    patchedSha256: stored.patchedSha256,
    productOriginalSha256: stored.productOriginalSha256,
    productPatchedSha256: stored.productPatchedSha256,
  };
}

export async function restoreWorkbenchDropCompatibility(
  options: WorkbenchDropCompatibilityOptions,
): Promise<WorkbenchDropCompatibilityResult> {
  return await withLock(options.stateDirectory, () => restoreLocked(options));
}

export async function inspectWorkbenchDropCompatibility(
  options: Pick<WorkbenchDropCompatibilityOptions, "appRoot" | "stateDirectory">,
): Promise<WorkbenchDropCompatibilityResult> {
  return await withLock(options.stateDirectory, async () => {
    const targetPath = workbenchDropTargetPath(options.appRoot);
    const productPath = workbenchProductPath(options.appRoot);
    const stored = await loadMetadata(options.stateDirectory);
    if (stored === "invalid") {
      return {
        status: "conflict",
        changed: false,
        targetPath,
        productPath,
        detail: "managed Workbench drop metadata is invalid",
      };
    }
    let source: Buffer;
    try {
      source = await readFile(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          status: "unavailable",
          changed: false,
          targetPath,
          productPath,
          detail: "VS Code Workbench entry asset is missing",
        };
      }
      throw error;
    }
    if (!stored) {
      const inspected = inspectWorkbenchDropSource(source.toString("utf8"));
      if (inspected.status === "compatible") {
        return {
          status: "conflict",
          changed: false,
          targetPath,
          productPath,
          detail: "Workbench contains a drop patch without matching Bridge restore metadata",
        };
      }
      if (inspected.status === "unsupported") {
        return {
          status: "unsupported",
          changed: false,
          targetPath,
          productPath,
          detail: inspected.detail,
        };
      }
      const productSource = await readFile(productPath);
      const productPatch = patchProductChecksum(
        productSource,
        source,
        Buffer.from(inspected.patchedSource, "utf8"),
      );
      return Buffer.isBuffer(productPatch)
        ? { status: "disabled", changed: false, targetPath, productPath }
        : {
            status: "unsupported",
            changed: false,
            targetPath,
            productPath,
            detail: productPatch.detail,
          };
    }
    if (resolve(stored.appRoot) !== resolve(options.appRoot)) {
      return {
        status: "conflict",
        changed: false,
        targetPath: stored.targetPath,
        productPath: stored.productPath,
        detail: "managed Workbench drop state belongs to another VS Code installation",
      };
    }
    const [currentSha256, currentProductSha256] = await Promise.all([
      Promise.resolve(sha256(source)),
      readFile(productPath).then(sha256),
    ]);
    const common = {
      changed: false,
      targetPath,
      productPath,
      originalSha256: stored.originalSha256,
      patchedSha256: stored.patchedSha256,
      productOriginalSha256: stored.productOriginalSha256,
      productPatchedSha256: stored.productPatchedSha256,
    };
    if (
      currentSha256 === stored.patchedSha256 &&
      currentProductSha256 === stored.productPatchedSha256
    ) {
      return { status: "already-patched", ...common };
    }
    if (
      currentSha256 === stored.originalSha256 &&
      currentProductSha256 === stored.productOriginalSha256
    ) {
      return {
        status: "already-restored",
        ...common,
        detail: "managed state is available to reapply the patch",
      };
    }
    return {
      status: "conflict",
      ...common,
      detail: "Workbench or product asset changed after the managed patch",
    };
  });
}
