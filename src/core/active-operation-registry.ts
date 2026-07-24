import { BridgeError } from "./errors.js";

export class ActiveOperationRegistry {
  readonly #operations = new Map<string, AbortController>();

  start(operationId: string): AbortSignal {
    if (this.#operations.has(operationId)) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Remote operation ID is already active",
        { operationId },
      );
    }
    const controller = new AbortController();
    this.#operations.set(operationId, controller);
    return controller.signal;
  }

  finish(operationId: string): void {
    this.#operations.delete(operationId);
  }

  cancel(operationId: string): boolean {
    const controller = this.#operations.get(operationId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const controller of this.#operations.values()) {
      controller.abort();
    }
    this.#operations.clear();
  }
}
