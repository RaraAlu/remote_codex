export const REMOTE_EXECUTOR_INSTALL_ATTEMPT_LIMIT = 2;
export const REMOTE_EXECUTOR_INSTALL_RESET_MS = 5 * 60_000;

export interface RemoteExecutorInstallMarker {
  attempts: number;
  digest: string;
  lastAttemptAt: number;
  version: 1;
}

export type RemoteExecutorInstallPlan =
  | { allowed: true; marker: RemoteExecutorInstallMarker }
  | { allowed: false; attempts: number; retryAfterMs: number };

function isInstallMarker(value: unknown): value is RemoteExecutorInstallMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return (
    marker.version === 1 &&
    typeof marker.digest === "string" &&
    Number.isInteger(marker.attempts) &&
    Number(marker.attempts) > 0 &&
    typeof marker.lastAttemptAt === "number" &&
    Number.isFinite(marker.lastAttemptAt)
  );
}

export function planRemoteExecutorInstall(
  value: unknown,
  digest: string,
  now = Date.now(),
): RemoteExecutorInstallPlan {
  const previous = isInstallMarker(value) ? value : null;
  const sameRecentPackage =
    previous?.digest === digest &&
    now - previous.lastAttemptAt >= 0 &&
    now - previous.lastAttemptAt < REMOTE_EXECUTOR_INSTALL_RESET_MS;
  const attempts = sameRecentPackage ? previous.attempts : 0;

  if (attempts >= REMOTE_EXECUTOR_INSTALL_ATTEMPT_LIMIT) {
    return {
      allowed: false,
      attempts,
      retryAfterMs: REMOTE_EXECUTOR_INSTALL_RESET_MS - (now - previous!.lastAttemptAt),
    };
  }

  return {
    allowed: true,
    marker: {
      attempts: attempts + 1,
      digest,
      lastAttemptAt: now,
      version: 1,
    },
  };
}
