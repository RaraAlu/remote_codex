import { describe, expect, it, vi } from "vitest";
import { DeferredExecutionEvents } from "../src/remote-extension/deferred-execution-events.js";

describe("DeferredExecutionEvents", () => {
  it("waits for the outer command acknowledgement and preserves output ordering", async () => {
    let release: (() => void) | undefined;
    const sink = vi.fn(async (_event: unknown) => undefined);
    const events = new DeferredExecutionEvents(
      "execute-1",
      sink,
      (callback) => {
        release = callback;
      },
    );

    events.output("stdout", "first");
    events.output("stderr", "second");
    const completed = events.complete({ ok: true, result: { exitCode: 0 } });
    await Promise.resolve();
    expect(sink).not.toHaveBeenCalled();

    release?.();
    await completed;
    expect(sink.mock.calls.map(([event]) => event)).toEqual([
      { channel: "stdout", chunk: "first", id: "execute-1" },
      { channel: "stderr", chunk: "second", id: "execute-1" },
      {
        event: "executionComplete",
        id: "execute-1",
        response: { ok: true, result: { exitCode: 0 } },
      },
    ]);
  });

  it("still delivers completion after one output event fails", async () => {
    let release: (() => void) | undefined;
    const sink = vi
      .fn()
      .mockRejectedValueOnce(new Error("output route unavailable"))
      .mockResolvedValue(undefined);
    const events = new DeferredExecutionEvents(
      "execute-2",
      sink,
      (callback) => {
        release = callback;
      },
    );

    events.output("stdout", "partial");
    const completed = events.complete({
      error: { code: "CANCELLED", message: "cancelled", retryable: false },
      ok: false,
    });
    release?.();
    await completed;

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]?.[0]).toMatchObject({
      event: "executionComplete",
      id: "execute-2",
      response: { ok: false },
    });
  });
});
