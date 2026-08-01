export interface RemoteExecutorReadinessResult<T> {
  attempts: number;
  elapsedMs: number;
  response: T | null;
  slow: boolean;
}

export interface WaitForRemoteExecutorReadinessOptions<T> {
  isReady: (value: unknown) => value is T;
  now?: () => number;
  onSlow?: (progress: { attempts: number; elapsedMs: number }) => void;
  pollIntervalMs?: number;
  probe: () => Promise<unknown>;
  retryWindowMs?: number;
  slowThresholdMs?: number;
}

export async function waitForRemoteExecutorReadiness<T>(
  options: WaitForRemoteExecutorReadinessOptions<T>,
): Promise<RemoteExecutorReadinessResult<T>> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (options.retryWindowMs ?? 10_000);
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const slowThresholdMs = options.slowThresholdMs ?? 2_000;
  let attempts = 0;
  let slow = false;
  const slowTimer = setTimeout(() => {
    slow = true;
    try {
      options.onSlow?.({
        attempts,
        elapsedMs: Math.max(0, now() - startedAt),
      });
    } catch {
      // Readiness diagnostics must not interrupt the capability probe.
    }
  }, slowThresholdMs);
  slowTimer.unref?.();

  try {
    do {
      attempts += 1;
      try {
        const response = await options.probe();
        if (options.isReady(response)) {
          return {
            attempts,
            elapsedMs: Math.max(0, now() - startedAt),
            response,
            slow,
          };
        }
      } catch {
        // The command is unavailable until the remote Extension Host registers it.
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        break;
      }
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(pollIntervalMs, remainingMs)),
      );
    } while (now() < deadline);
    return {
      attempts,
      elapsedMs: Math.max(0, now() - startedAt),
      response: null,
      slow,
    };
  } finally {
    clearTimeout(slowTimer);
  }
}
