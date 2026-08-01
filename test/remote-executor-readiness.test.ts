import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForRemoteExecutorReadiness } from "../src/extension/remote-executor-readiness.js";

interface ReadyResponse {
  ready: true;
}

function isReady(value: unknown): value is ReadyResponse {
  return Boolean(value) && typeof value === "object" && (value as ReadyResponse).ready === true;
}

describe("Remote Executor readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records retries and elapsed time before the capability probe succeeds", async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("command is not registered"))
      .mockResolvedValueOnce({ ready: true });

    const pending = waitForRemoteExecutorReadiness({
      isReady,
      pollIntervalMs: 500,
      probe,
      retryWindowMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toMatchObject({
      attempts: 2,
      elapsedMs: 500,
      response: { ready: true },
      slow: false,
    });
  });

  it("reports a slow probe even while the remote command promise is pending", async () => {
    vi.useFakeTimers();
    let resolveProbe!: (value: unknown) => void;
    const probe = vi.fn(
      async () =>
        await new Promise<unknown>((resolvePromise) => {
          resolveProbe = resolvePromise;
        }),
    );
    const onSlow = vi.fn();

    const pending = waitForRemoteExecutorReadiness({
      isReady,
      onSlow,
      probe,
      slowThresholdMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onSlow).toHaveBeenCalledWith({ attempts: 1, elapsedMs: 2_000 });
    resolveProbe({ ready: true });
    await expect(pending).resolves.toMatchObject({
      attempts: 1,
      elapsedMs: 2_000,
      slow: true,
    });
  });

  it("returns measured unavailability after the retry window", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => null);

    const pending = waitForRemoteExecutorReadiness({
      isReady,
      pollIntervalMs: 250,
      probe,
      retryWindowMs: 1_000,
      slowThresholdMs: 500,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      attempts: 4,
      elapsedMs: 1_000,
      response: null,
      slow: true,
    });
  });
});
