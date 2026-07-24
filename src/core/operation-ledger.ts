import { asBridgeError, BridgeError } from "./errors.js";
import type { BridgeErrorPayload } from "./types.js";

export type OperationState =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown";

export type IdempotencyOutcome = "executed" | "joined" | "replayed";

export interface OperationSnapshot<T = unknown> {
  error?: BridgeErrorPayload;
  result?: T;
  status: OperationState;
}

export interface OperationHandle<T> {
  outcome: IdempotencyOutcome;
  result: Promise<T>;
}

interface OperationEntry<T> {
  controller: AbortController;
  entryId: string;
  fingerprint: string;
  operationIds: Set<string>;
  result: Promise<T>;
  sizeBytes: number;
  settledAt?: number;
  snapshot: OperationSnapshot<T>;
}

function terminalState(error: BridgeError): OperationState {
  if (error.code === "CANCELLED") {
    return "cancelled";
  }
  if (error.code === "RESULT_UNKNOWN") {
    return "unknown";
  }
  return "failed";
}

export class OperationLedger<T = unknown> {
  readonly #entries = new Map<string, OperationEntry<T>>();
  readonly #operations = new Map<string, OperationEntry<T>>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #retentionMs: number;
  #storedBytes = 0;

  constructor(
    maxEntries = 256,
    retentionMs = 15 * 60_000,
    maxBytes = 64 * 1024 * 1024,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("Operation ledger maxEntries must be a positive integer");
    }
    if (!Number.isInteger(retentionMs) || retentionMs < 1) {
      throw new TypeError("Operation ledger retentionMs must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("Operation ledger maxBytes must be a positive integer");
    }
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
    this.#retentionMs = retentionMs;
  }

  start(
    entryId: string,
    operationId: string,
    fingerprint: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): OperationHandle<T> {
    this.#prune();
    const existing = this.#entries.get(entryId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BridgeError(
          "PROTOCOL_MISMATCH",
          "Idempotency key was reused with different operation parameters",
        );
      }
      const outcome: IdempotencyOutcome =
        existing.snapshot.status === "running" ? "joined" : "replayed";
      if (existing.snapshot.status === "running") {
        this.#bindOperation(operationId, existing);
      }
      return { outcome, result: existing.result };
    }

    this.#makeCapacity();
    if (this.#operations.has(operationId)) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Remote operation ID is already bound to another request",
        { operationId },
      );
    }
    const controller = new AbortController();
    let entry: OperationEntry<T>;
    const result = Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          this.#settle(entry, { result: value, status: "completed" });
          return value;
        },
        (error: unknown) => {
          const bridgeError = asBridgeError(error, "REMOTE_TRANSPORT_DISCONNECTED");
          this.#settle(entry, {
            error: bridgeError.toPayload(),
            status: terminalState(bridgeError),
          });
          throw bridgeError;
        },
      );
    entry = {
      controller,
      entryId,
      fingerprint,
      operationIds: new Set(),
      result,
      sizeBytes: 0,
      snapshot: { status: "running" },
    };
    this.#entries.set(entryId, entry);
    this.#bindOperation(operationId, entry);
    return { outcome: "executed", result };
  }

  status(entryId: string): OperationSnapshot<T> {
    this.#prune();
    const entry = this.#entries.get(entryId);
    if (!entry) {
      return { status: "unknown" };
    }
    return {
      ...entry.snapshot,
      ...(entry.snapshot.error
        ? {
            error: {
              ...entry.snapshot.error,
              ...(entry.snapshot.error.details
                ? { details: { ...entry.snapshot.error.details } }
                : {}),
            },
          }
        : {}),
    };
  }

  cancel(operationId: string): boolean {
    const entry = this.#operations.get(operationId);
    if (!entry || entry.snapshot.status !== "running") {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  close(): void {
    for (const entry of this.#entries.values()) {
      if (entry.snapshot.status === "running") {
        entry.controller.abort();
      }
    }
    this.#operations.clear();
    this.#entries.clear();
    this.#storedBytes = 0;
  }

  #bindOperation(operationId: string, entry: OperationEntry<T>): void {
    const existing = this.#operations.get(operationId);
    if (existing && existing !== entry) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Remote operation ID is already bound to another request",
        { operationId },
      );
    }
    entry.operationIds.add(operationId);
    this.#operations.set(operationId, entry);
  }

  #settle(entry: OperationEntry<T>, snapshot: OperationSnapshot<T>): void {
    const sizeBytes = this.#snapshotSize(snapshot);
    if (sizeBytes > this.#maxBytes - this.#storedBytes) {
      const unknown = new BridgeError(
        "RESULT_UNKNOWN",
        "Remote operation result exceeded the bounded idempotency ledger",
        { maxLedgerBytes: this.#maxBytes },
      );
      const replay = Promise.reject(unknown);
      void replay.catch(() => undefined);
      entry.result = replay;
      entry.snapshot = {
        error: unknown.toPayload(),
        status: "unknown",
      };
      entry.sizeBytes = this.#snapshotSize(entry.snapshot);
    } else {
      entry.snapshot = snapshot;
      entry.sizeBytes = sizeBytes;
    }
    this.#storedBytes += entry.sizeBytes;
    entry.settledAt = Date.now();
    for (const operationId of entry.operationIds) {
      if (this.#operations.get(operationId) === entry) {
        this.#operations.delete(operationId);
      }
    }
    entry.operationIds.clear();
  }

  #prune(): void {
    const cutoff = Date.now() - this.#retentionMs;
    for (const [entryId, entry] of this.#entries) {
      if (entry.settledAt !== undefined && entry.settledAt <= cutoff) {
        this.#deleteEntry(entryId, entry);
      }
    }
  }

  #makeCapacity(): void {
    if (
      this.#entries.size < this.#maxEntries &&
      this.#storedBytes < this.#maxBytes
    ) {
      return;
    }
    throw new BridgeError(
      "COMMAND_DENIED",
      "Remote operation ledger is at capacity",
      {
        maxBytes: this.#maxBytes,
        maxEntries: this.#maxEntries,
      },
    );
  }

  #deleteEntry(entryId: string, entry: OperationEntry<T>): void {
    if (this.#entries.get(entryId) !== entry) {
      return;
    }
    this.#entries.delete(entryId);
    this.#storedBytes = Math.max(0, this.#storedBytes - entry.sizeBytes);
  }

  #snapshotSize(snapshot: OperationSnapshot<T>): number {
    try {
      return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    } catch {
      return this.#maxBytes + 1;
    }
  }
}
