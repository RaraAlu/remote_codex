import { BridgeError } from "./errors.js";
import { BRIDGE_STATES, type BridgeState } from "./types.js";

const TRANSITIONS: Record<BridgeState, ReadonlySet<BridgeState>> = {
  disabled: new Set(["configuring", "connecting"]),
  configuring: new Set(["disabled", "connecting", "disconnected", "incompatible"]),
  connecting: new Set(["ready", "degraded", "disconnected", "incompatible", "disabled"]),
  ready: new Set(["busy", "degraded", "disconnected", "incompatible", "disabled"]),
  busy: new Set(["ready", "degraded", "disconnected", "incompatible", "disabled"]),
  degraded: new Set(["connecting", "ready", "disconnected", "incompatible", "disabled"]),
  disconnected: new Set(["connecting", "disabled", "incompatible"]),
  incompatible: new Set(["configuring", "disabled", "connecting"]),
};

export type StateListener = (current: BridgeState, previous: BridgeState) => void;

export class BridgeStateMachine {
  #state: BridgeState;
  readonly #listeners = new Set<StateListener>();

  constructor(initial: BridgeState = "disabled") {
    this.#state = BRIDGE_STATES.includes(initial) ? initial : "disconnected";
  }

  get state(): BridgeState {
    return this.#state;
  }

  onChange(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  transition(next: BridgeState): void {
    if (!BRIDGE_STATES.includes(next)) {
      next = "disconnected";
    }
    if (next === this.#state) {
      return;
    }
    if (!TRANSITIONS[this.#state].has(next)) {
      throw new BridgeError(
        "BRIDGE_NOT_READY",
        `Invalid bridge state transition: ${this.#state} -> ${next}`,
      );
    }
    const previous = this.#state;
    this.#state = next;
    for (const listener of this.#listeners) {
      listener(next, previous);
    }
  }

  assertOperational(readOnly = false): void {
    const allowed = this.#state === "ready" || this.#state === "busy";
    const degradedRead = readOnly && this.#state === "degraded";
    if (!allowed && !degradedRead) {
      throw new BridgeError("BRIDGE_NOT_READY", `Bridge state is ${this.#state}`);
    }
  }
}
