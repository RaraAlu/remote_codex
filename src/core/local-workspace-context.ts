import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { chmodIfSupported } from "./file-permissions.js";
import { bridgeStateDir } from "./locations.js";

export const LOCAL_WORKSPACE_ROOT_ENV = "CODEX_BRIDGE_LOCAL_WORKSPACE_ROOT";

export interface LocalWorkspaceFolder {
  uri: {
    fsPath: string;
    scheme: string;
  };
}

interface LocalWorkspaceContext {
  version: 1;
  workspaceRoot: string;
}

export function localWorkspaceContextPath(
  extensionHostPid = process.ppid,
  stateDirectory = bridgeStateDir(),
): string {
  if (!Number.isSafeInteger(extensionHostPid) || extensionHostPid <= 0) {
    throw new TypeError("Extension Host PID must be a positive integer");
  }
  return join(stateDirectory, "local-workspaces", `${extensionHostPid}.json`);
}

export function localWorkspaceRoot(
  remoteName: string | undefined,
  workspaceFolders: readonly LocalWorkspaceFolder[] | undefined,
): string | null {
  if (
    remoteName !== undefined ||
    workspaceFolders?.length !== 1 ||
    workspaceFolders[0]?.uri.scheme !== "file" ||
    !isAbsolute(workspaceFolders[0].uri.fsPath)
  ) {
    return null;
  }
  return resolve(workspaceFolders[0].uri.fsPath);
}

export function publishLocalWorkspaceRoot(
  environment: NodeJS.ProcessEnv,
  remoteName: string | undefined,
  workspaceFolders: readonly LocalWorkspaceFolder[] | undefined,
): string | null {
  const root = localWorkspaceRoot(remoteName, workspaceFolders);
  if (root) {
    environment[LOCAL_WORKSPACE_ROOT_ENV] = root;
  } else {
    delete environment[LOCAL_WORKSPACE_ROOT_ENV];
  }
  return root;
}

export function takeLocalWorkspaceRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = environment[LOCAL_WORKSPACE_ROOT_ENV];
  delete environment[LOCAL_WORKSPACE_ROOT_ENV];
  return value && isAbsolute(value) ? resolve(value) : null;
}

export async function saveLocalWorkspaceContext(
  path: string,
  workspaceRoot: string | null,
): Promise<void> {
  if (workspaceRoot === null) {
    await clearLocalWorkspaceContext(path);
    return;
  }
  if (!isAbsolute(workspaceRoot)) {
    throw new TypeError("Local workspace root must be absolute");
  }
  const record: LocalWorkspaceContext = {
    version: 1,
    workspaceRoot: resolve(workspaceRoot),
  };
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmodIfSupported(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmodIfSupported(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadLocalWorkspaceContext(path: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("workspaceRoot" in parsed) ||
      typeof parsed.workspaceRoot !== "string" ||
      !isAbsolute(parsed.workspaceRoot)
    ) {
      return null;
    }
    return resolve(parsed.workspaceRoot);
  } catch {
    return null;
  }
}

export async function clearLocalWorkspaceContext(path: string): Promise<void> {
  await rm(path, { force: true });
}
