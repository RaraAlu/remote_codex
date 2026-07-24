import { describe, expect, it } from "vitest";
import { ActiveOperationRegistry } from "../src/core/active-operation-registry.js";

describe("ActiveOperationRegistry", () => {
  it("binds cancellation to one active operation id", () => {
    const registry = new ActiveOperationRegistry();
    const first = registry.start("host\0/workspace\0operation-1");
    const second = registry.start("host\0/workspace\0operation-2");

    expect(registry.cancel("host\0/workspace\0operation-1")).toBe(true);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(registry.cancel("host\0/workspace\0missing")).toBe(false);

    registry.finish("host\0/workspace\0operation-1");
    expect(registry.cancel("host\0/workspace\0operation-1")).toBe(false);
  });

  it("rejects duplicate active ids and cancels all remaining operations", () => {
    const registry = new ActiveOperationRegistry();
    const signal = registry.start("operation");

    expect(() => registry.start("operation")).toThrowError(
      expect.objectContaining({ code: "PROTOCOL_MISMATCH" }),
    );
    registry.cancelAll();
    expect(signal.aborted).toBe(true);
    expect(registry.cancel("operation")).toBe(false);
  });
});
