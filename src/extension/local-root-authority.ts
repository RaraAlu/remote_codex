import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize, parse, relative, sep } from "node:path";
import type * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";
import type { WorkspaceRootConfig } from "../core/types.js";

const LOCAL_ROOTS_KEY = "codexRemoteBridge.localRoots.v1";
const MAX_LOCAL_ROOTS = 15;

interface StoredLocalRoots {
  version: 1;
  roots: WorkspaceRootConfig[];
}

export interface LocalRootDiagnostic extends WorkspaceRootConfig {
  accessible: boolean;
  error: string | null;
}

function parseStoredRoot(value: unknown, index: number): WorkspaceRootConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("INVALID_CONFIG", `Stored local root ${index} must be an object`);
  }
  const root = value as Record<string, unknown>;
  if (
    typeof root.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(root.id) ||
    root.target !== "local" ||
    root.role !== "secondary" ||
    typeof root.path !== "string" ||
    !isAbsolute(root.path) ||
    normalize(root.path) !== root.path ||
    parse(root.path).root === root.path ||
    typeof root.displayName !== "string" ||
    root.displayName.trim() === "" ||
    root.displayName.length > 128
  ) {
    throw new BridgeError("INVALID_CONFIG", `Stored local root ${index} is invalid`);
  }
  return {
    id: root.id,
    target: "local",
    role: "secondary",
    path: root.path,
    displayName: root.displayName,
  };
}

function parseStoredRoots(value: unknown): WorkspaceRootConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("INVALID_CONFIG", "Stored local root authorization is invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !Array.isArray(state.roots) ||
    state.roots.length > MAX_LOCAL_ROOTS
  ) {
    throw new BridgeError("INVALID_CONFIG", "Stored local root authorization is invalid");
  }
  const roots = state.roots.map(parseStoredRoot);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const root of roots) {
    if (ids.has(root.id) || paths.has(root.path)) {
      throw new BridgeError("INVALID_CONFIG", "Stored local roots contain a duplicate");
    }
    ids.add(root.id);
    paths.add(root.path);
  }
  return roots;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function canonicalDirectory(selectedPath: string): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(selectedPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new BridgeError("COMMAND_DENIED", "The selected local root is not a directory");
    }
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError(
      "COMMAND_DENIED",
      "The selected local root does not exist or cannot be opened",
      { path: selectedPath },
      { cause: error },
    );
  }
  if (
    !isAbsolute(canonicalPath) ||
    normalize(canonicalPath) !== canonicalPath ||
    parse(canonicalPath).root === canonicalPath
  ) {
    throw new BridgeError(
      "COMMAND_DENIED",
      "The selected local root must not be a filesystem root",
    );
  }
  return canonicalPath;
}

function localRoot(canonicalPath: string): WorkspaceRootConfig {
  return {
    id: `local-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16)}`,
    target: "local",
    role: "secondary",
    path: canonicalPath,
    displayName: basename(canonicalPath).slice(0, 128),
  };
}

export class LocalRootAuthority {
  readonly #state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.#state = state;
  }

  roots(): WorkspaceRootConfig[] {
    return parseStoredRoots(this.#state.get<unknown>(LOCAL_ROOTS_KEY));
  }

  find(rootId: string): WorkspaceRootConfig | undefined {
    return this.roots().find((root) => root.id === rootId);
  }

  availableSlots(): number {
    return MAX_LOCAL_ROOTS - this.roots().length;
  }

  async findContainingDirectory(
    selectedPath: string,
  ): Promise<WorkspaceRootConfig | undefined> {
    const canonicalPath = await canonicalDirectory(selectedPath);
    return this.roots().find((root) => isWithinRoot(root.path, canonicalPath));
  }

  async authorize(selectedPath: string): Promise<WorkspaceRootConfig> {
    const canonicalPath = await canonicalDirectory(selectedPath);
    const current = this.roots();
    const existing = current.find((root) => isWithinRoot(root.path, canonicalPath));
    if (existing) {
      return existing;
    }
    if (current.length >= MAX_LOCAL_ROOTS) {
      throw new BridgeError(
        "COMMAND_DENIED",
        `At most ${MAX_LOCAL_ROOTS} local roots may be authorized`,
      );
    }

    const root = localRoot(canonicalPath);
    const collision = current.find((candidate) => candidate.id === root.id);
    if (collision) {
      throw new BridgeError("INVALID_CONFIG", "Local root authorization ID collision");
    }
    await this.#save([...current, root]);
    return root;
  }

  async revoke(rootId: string): Promise<boolean> {
    const current = this.roots();
    const next = current.filter((root) => root.id !== rootId);
    if (next.length === current.length) {
      return false;
    }
    await this.#save(next);
    return true;
  }

  async diagnostics(): Promise<LocalRootDiagnostic[]> {
    return await Promise.all(
      this.roots().map(async (root) => {
        try {
          const canonicalPath = await realpath(root.path);
          const metadata = await stat(canonicalPath);
          if (canonicalPath !== root.path || !metadata.isDirectory()) {
            throw new Error("The authorized path no longer resolves to the selected directory");
          }
          return { ...root, accessible: true, error: null };
        } catch (error) {
          return {
            ...root,
            accessible: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  async #save(roots: WorkspaceRootConfig[]): Promise<void> {
    const value: StoredLocalRoots | undefined =
      roots.length === 0 ? undefined : { version: 1, roots };
    await this.#state.update(LOCAL_ROOTS_KEY, value);
  }
}
