import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/core/errors.js";
import { BridgeStateMachine } from "../src/core/state-machine.js";

describe("BridgeStateMachine", () => {
  it("emits explicit valid transitions", () => {
    const state = new BridgeStateMachine();
    const listener = vi.fn();
    state.onChange(listener);
    state.transition("connecting");
    state.transition("ready");
    state.transition("busy");
    state.transition("disconnected");
    expect(state.state).toBe("disconnected");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid transitions and operations while disconnected", () => {
    const state = new BridgeStateMachine();
    expect(() => state.transition("ready")).toThrowError(BridgeError);
    state.transition("connecting");
    state.transition("disconnected");
    expect(() => state.assertOperational()).toThrowError(/disconnected/);
  });

  it("allows only read operations in degraded state", () => {
    const state = new BridgeStateMachine("connecting");
    state.transition("degraded");
    expect(() => state.assertOperational(true)).not.toThrow();
    expect(() => state.assertOperational(false)).toThrowError(BridgeError);
  });
});
