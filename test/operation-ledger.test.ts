import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/core/errors.js";
import { OperationLedger } from "../src/core/operation-ledger.js";

describe("OperationLedger", () => {
  it("joins a running operation and replays its completed result", async () => {
    const ledger = new OperationLedger<string>();
    let finish: ((value: string) => void) | undefined;
    const operation = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const first = ledger.start("entry", "operation-1", "fingerprint", operation);
    const joined = ledger.start("entry", "operation-2", "fingerprint", operation);
    expect(first.outcome).toBe("executed");
    expect(joined.outcome).toBe("joined");
    expect(operation).toHaveBeenCalledTimes(0);

    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    finish?.("done");
    await expect(first.result).resolves.toBe("done");
    await expect(joined.result).resolves.toBe("done");
    const replayed = ledger.start("entry", "operation-3", "fingerprint", operation);
    expect(replayed.outcome).toBe("replayed");
    await expect(replayed.result).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(ledger.status("entry")).toEqual({
      result: "done",
      status: "completed",
    });
  });

  it("rejects parameter conflicts and records cancellation", async () => {
    const ledger = new OperationLedger<string>();
    const running = ledger.start("entry", "operation-1", "fingerprint", async (signal) => {
      return await new Promise<string>((_resolve, reject) => {
        const cancel = (): void =>
          reject(new BridgeError("CANCELLED", "operation cancelled"));
        if (signal.aborted) {
          cancel();
        } else {
          signal.addEventListener("abort", cancel, { once: true });
        }
      });
    });

    expect(() =>
      ledger.start("entry", "operation-2", "different", async () => "duplicate"),
    ).toThrowError(expect.objectContaining({ code: "PROTOCOL_MISMATCH" }));
    expect(() =>
      ledger.start("other-entry", "operation-1", "other", async () => "duplicate"),
    ).toThrowError(expect.objectContaining({ code: "PROTOCOL_MISMATCH" }));
    expect(ledger.cancel("operation-1")).toBe(true);
    await expect(running.result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(ledger.status("entry")).toMatchObject({
      error: { code: "CANCELLED" },
      status: "cancelled",
    });
    expect(ledger.cancel("operation-1")).toBe(false);
    expect(ledger.status("missing")).toEqual({ status: "unknown" });
  });

  it("expires terminal entries but never evicts a running operation", async () => {
    const ledger = new OperationLedger<string>(1, 1);
    const completed = ledger.start("first", "operation-1", "first", async () => "done");
    await completed.result;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replacement = ledger.start(
      "second",
      "operation-2",
      "second",
      async () => "replacement",
    );
    await replacement.result;
    expect(ledger.status("first")).toEqual({ status: "unknown" });

    const blocked = new OperationLedger<string>(1);
    const running = blocked.start(
      "running",
      "operation-3",
      "running",
      async (signal) =>
        await new Promise<string>((_resolve, reject) => {
          const cancel = (): void =>
            reject(new BridgeError("CANCELLED", "closed"));
          if (signal.aborted) {
            cancel();
          } else {
            signal.addEventListener("abort", cancel, { once: true });
          }
        }),
    );
    expect(() =>
      blocked.start("overflow", "operation-4", "overflow", async () => "no"),
    ).toThrowError(expect.objectContaining({ code: "COMMAND_DENIED" }));
    blocked.close();
    await expect(running.result).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("keeps an unknown tombstone when a result exceeds the byte budget", async () => {
    const ledger = new OperationLedger<string>(4, 60_000, 512);
    const operation = vi.fn(async () => "x".repeat(1_024));
    const first = ledger.start("large", "operation-1", "large", operation);

    await expect(first.result).resolves.toHaveLength(1_024);
    expect(ledger.status("large")).toMatchObject({
      error: { code: "RESULT_UNKNOWN" },
      status: "unknown",
    });
    const replayed = ledger.start("large", "operation-2", "large", operation);
    expect(replayed.outcome).toBe("replayed");
    await expect(replayed.result).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
