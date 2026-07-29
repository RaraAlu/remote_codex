import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadShimRuntimeStatus,
  saveShimRuntimeStatus,
  shimRuntimeHealth,
  type ShimRuntimeStatus,
} from "../src/core/shim-runtime-status.js";

function status(overrides: Partial<ShimRuntimeStatus> = {}): ShimRuntimeStatus {
  return {
    version: 1,
    host: "g1_1",
    workspaceRoot: "/remote/workspace",
    shimExecutable: "/managed/codex-bridge-shim",
    nodeExecutable: null,
    extensionHostPid: 3131,
    shimPid: 4242,
    shimStartedAtMs: 100,
    running: true,
    shimLastExitCode: null,
    appServerInitializedAtMs: 200,
    appServerLastError: null,
    updatedAtMs: 200,
    ...overrides,
  };
}

describe("Shim runtime status", () => {
  it("persists a private status document and loads it strictly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shim-runtime-"));
    const path = join(directory, "nested", "status.json");
    const value = status();

    await saveShimRuntimeStatus(path, value);

    await expect(loadShimRuntimeStatus(path)).resolves.toEqual(value);
  });

  it("only reports app-server readiness while the recorded Shim is alive", () => {
    expect(shimRuntimeHealth(status(), () => true, 3131)).toMatchObject({
      nodeExecutable: null,
      shimStarted: true,
      shimPid: 4242,
      shimLastExitCode: null,
      appServerInitialized: true,
      appServerLastError: null,
    });
    expect(shimRuntimeHealth(status(), () => false)).toMatchObject({
      shimStarted: false,
      appServerInitialized: false,
      appServerInitializedAtMs: 200,
    });
    expect(shimRuntimeHealth(status(), () => true, 9999)).toMatchObject({
      shimStarted: false,
      appServerInitialized: false,
    });
  });

  it("retains the last exit and app-server error for diagnostics", () => {
    expect(
      shimRuntimeHealth(
        status({
          running: false,
          shimLastExitCode: 127,
          appServerInitializedAtMs: null,
          appServerLastError: "Official Codex app-server exited with code 127",
        }),
        () => false,
      ),
    ).toMatchObject({
      shimStarted: false,
      shimLastExitCode: 127,
      appServerInitialized: false,
      appServerLastError: "Official Codex app-server exited with code 127",
    });
  });
});
