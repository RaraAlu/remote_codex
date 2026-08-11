import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize, parse } from "node:path";
import type * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";
import type {
  ConversationResourceConfig,
  ConversationResourceKind,
} from "../core/types.js";

const CONVERSATION_RESOURCE_PREFIX =
  "codexRemoteBridge.conversationResources.v2.";
const PENDING_DROP_TTL_MS = 30 * 60_000;

interface StoredConversationResources {
  version: 2;
  threadId: string;
  resources: ConversationResourceConfig[];
}

interface PendingResource {
  kind: ConversationResourceKind;
  path: string;
  stagedAtMs: number;
}

export interface StagedConversationResource {
  displayName: string;
  kind: ConversationResourceKind;
  path: string;
}

export interface ConversationResourceClaim {
  claimed: ConversationResourceConfig[];
  resources: ConversationResourceConfig[];
}

function validThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\0")
  );
}

function threadKey(threadId: string): string {
  return `${CONVERSATION_RESOURCE_PREFIX}${createHash("sha256")
    .update(threadId)
    .digest("hex")}`;
}

function resourceId(
  threadId: string,
  kind: ConversationResourceKind,
  path: string,
): string {
  return `context-${createHash("sha256")
    .update(`${threadId}\0${kind}\0${path}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function parseResource(
  value: unknown,
  threadId: string,
  index: number,
): ConversationResourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `Stored conversation resource ${index} must be an object`,
    );
  }
  const resource = value as Record<string, unknown>;
  if (
    resource.target !== "local" ||
    resource.role !== "conversation" ||
    (resource.kind !== "file" && resource.kind !== "directory") ||
    typeof resource.path !== "string" ||
    !isAbsolute(resource.path) ||
    normalize(resource.path) !== resource.path ||
    typeof resource.displayName !== "string" ||
    resource.displayName.trim() === "" ||
    resource.displayName.length > 128 ||
    resource.threadId !== threadId ||
    resource.id !== resourceId(threadId, resource.kind, resource.path)
  ) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `Stored conversation resource ${index} is invalid`,
    );
  }
  if (resource.kind === "directory" && parse(resource.path).root === resource.path) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "Stored conversation resources must not expose a filesystem root",
    );
  }
  return {
    id: resource.id,
    target: "local",
    role: "conversation",
    kind: resource.kind,
    path: resource.path,
    displayName: resource.displayName,
    threadId,
  };
}

function parseThreadState(
  value: unknown,
  expectedThreadId?: string,
): { resources: ConversationResourceConfig[]; threadId: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("INVALID_CONFIG", "Stored conversation resources are invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 2 ||
    !validThreadId(state.threadId) ||
    (expectedThreadId !== undefined && state.threadId !== expectedThreadId) ||
    !Array.isArray(state.resources)
  ) {
    throw new BridgeError("INVALID_CONFIG", "Stored conversation resources are invalid");
  }
  const resources = state.resources.map((resource, index) =>
    parseResource(resource, state.threadId as string, index),
  );
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const resource of resources) {
    if (ids.has(resource.id) || paths.has(resource.path)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Stored conversation resources contain a duplicate",
      );
    }
    ids.add(resource.id);
    paths.add(resource.path);
  }
  return { resources, threadId: state.threadId };
}

async function canonicalResource(path: string): Promise<PendingResource> {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 32 * 1024 ||
    path.includes("\0")
  ) {
    throw new BridgeError("COMMAND_DENIED", "Dropped local resource path is invalid");
  }
  try {
    const canonicalPath = await realpath(path);
    const metadata = await stat(canonicalPath);
    let kind: ConversationResourceKind;
    if (metadata.isDirectory()) {
      kind = "directory";
    } else if (metadata.isFile()) {
      kind = "file";
    } else {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Dropped local resource must be a regular file or directory",
      );
    }
    if (kind === "directory" && parse(canonicalPath).root === canonicalPath) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Dropping a filesystem root into a conversation is not allowed",
      );
    }
    return { kind, path: canonicalPath, stagedAtMs: Date.now() };
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError(
      "COMMAND_DENIED",
      "Dropped local resource does not exist or cannot be opened",
      { path },
      { cause: error },
    );
  }
}

export class ConversationResourceAuthority {
  readonly #pending = new Map<string, PendingResource>();
  readonly #state: vscode.Memento;
  #stateBarrier: Promise<void> = Promise.resolve();

  constructor(state: vscode.Memento) {
    this.#state = state;
  }

  async stageDropped(
    paths: readonly string[],
  ): Promise<StagedConversationResource[]> {
    this.#purgePending();
    const staged = new Map<string, PendingResource>();
    for (const path of paths) {
      const resource = await canonicalResource(path);
      staged.set(resource.path, resource);
      this.#pending.set(resource.path, resource);
    }
    return [...staged.values()].map((resource) => ({
      kind: resource.kind,
      path: resource.path,
      displayName: basename(resource.path).slice(0, 128),
    }));
  }

  async claim(
    threadId: string,
    mentionPaths: readonly string[],
  ): Promise<ConversationResourceClaim> {
    if (!validThreadId(threadId)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Conversation thread ID is invalid");
    }
    return await this.#serializeStateMutation(async () => {
      this.#purgePending();
      const current = this.resources(threadId);
      const byPath = new Map(current.map((resource) => [resource.path, resource]));
      const claimed: ConversationResourceConfig[] = [];
      for (const mentionPath of mentionPaths) {
        let canonical: PendingResource;
        try {
          canonical = await canonicalResource(mentionPath);
        } catch {
          continue;
        }
        if (byPath.has(canonical.path)) {
          this.#pending.delete(canonical.path);
          continue;
        }
        const pending = this.#pending.get(canonical.path);
        if (!pending || pending.kind !== canonical.kind) {
          continue;
        }
        const resource: ConversationResourceConfig = {
          id: resourceId(threadId, canonical.kind, canonical.path),
          target: "local",
          role: "conversation",
          kind: canonical.kind,
          path: canonical.path,
          displayName: basename(canonical.path).slice(0, 128),
          threadId,
        };
        current.push(resource);
        byPath.set(resource.path, resource);
        claimed.push(resource);
        this.#pending.delete(canonical.path);
      }
      if (claimed.length > 0) {
        await this.#saveThread(threadId, current);
      }
      return { claimed, resources: current };
    });
  }

  resources(threadId: string): ConversationResourceConfig[] {
    if (!validThreadId(threadId)) {
      return [];
    }
    return [
      ...(parseThreadState(
        this.#state.get<unknown>(threadKey(threadId)),
        threadId,
      )?.resources ?? []),
    ];
  }

  find(threadId: string, resourceIdValue: string): ConversationResourceConfig | undefined {
    return this.resources(threadId).find((resource) => resource.id === resourceIdValue);
  }

  async deleteThread(threadId: string): Promise<boolean> {
    if (!validThreadId(threadId)) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Conversation thread ID is invalid");
    }
    return await this.#serializeStateMutation(async () => {
      const key = threadKey(threadId);
      if (this.#state.get<unknown>(key) === undefined) {
        return false;
      }
      await this.#state.update(key, undefined);
      return true;
    });
  }

  summary(): { resourceCount: number; threadCount: number } {
    const keys = typeof this.#state.keys === "function" ? this.#state.keys() : [];
    let resourceCount = 0;
    let threadCount = 0;
    for (const key of keys) {
      if (!key.startsWith(CONVERSATION_RESOURCE_PREFIX)) {
        continue;
      }
      const state = parseThreadState(this.#state.get<unknown>(key));
      if (state) {
        resourceCount += state.resources.length;
        threadCount += 1;
      }
    }
    return { resourceCount, threadCount };
  }

  async #saveThread(
    threadId: string,
    resources: ConversationResourceConfig[],
  ): Promise<void> {
    const value: StoredConversationResources = {
      version: 2,
      threadId,
      resources,
    };
    await this.#state.update(threadKey(threadId), value);
  }

  async #serializeStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#stateBarrier;
    let release: (() => void) | undefined;
    this.#stateBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  #purgePending(): void {
    const cutoff = Date.now() - PENDING_DROP_TTL_MS;
    for (const [path, resource] of this.#pending) {
      if (resource.stagedAtMs < cutoff) {
        this.#pending.delete(path);
      }
    }
  }
}
