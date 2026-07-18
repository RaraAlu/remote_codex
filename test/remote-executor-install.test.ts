import { describe, expect, it } from "vitest";
import {
  planRemoteExecutorInstall,
  REMOTE_EXECUTOR_INSTALL_RESET_MS,
} from "../src/extension/remote-executor-install.js";

describe("Remote Executor installation recovery", () => {
  const now = 10_000_000;

  it("starts a new bounded attempt for missing or legacy markers", () => {
    expect(planRemoteExecutorInstall(undefined, "new", now)).toMatchObject({
      allowed: true,
      marker: { attempts: 1, digest: "new", version: 1 },
    });
    expect(planRemoteExecutorInstall("legacy-digest", "legacy-digest", now)).toMatchObject({
      allowed: true,
      marker: { attempts: 1, digest: "legacy-digest", version: 1 },
    });
  });

  it("allows one retry after a recent install attempt", () => {
    const first = planRemoteExecutorInstall(undefined, "digest", now);
    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      return;
    }
    expect(planRemoteExecutorInstall(first.marker, "digest", now + 1_000)).toMatchObject({
      allowed: true,
      marker: { attempts: 2, digest: "digest" },
    });
  });

  it("stops reload loops after two recent attempts", () => {
    expect(
      planRemoteExecutorInstall(
        { attempts: 2, digest: "digest", lastAttemptAt: now - 1_000, version: 1 },
        "digest",
        now,
      ),
    ).toMatchObject({ allowed: false, attempts: 2 });
  });

  it("recovers after the retry window or a package change", () => {
    const exhausted = {
      attempts: 2,
      digest: "old",
      lastAttemptAt: now - REMOTE_EXECUTOR_INSTALL_RESET_MS,
      version: 1 as const,
    };
    expect(planRemoteExecutorInstall(exhausted, "old", now)).toMatchObject({
      allowed: true,
      marker: { attempts: 1 },
    });
    expect(planRemoteExecutorInstall({ ...exhausted, lastAttemptAt: now }, "new", now)).toMatchObject(
      {
        allowed: true,
        marker: { attempts: 1, digest: "new" },
      },
    );
  });
});
