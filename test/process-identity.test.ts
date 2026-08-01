import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  currentProcessStartedAtMs,
  inspectProcessIdentities,
  processExecutablePathsEqual,
} from "../src/shim/process-identity.js";

describe("process identity inspection", () => {
  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "reads the current process executable and start time",
    async () => {
      const identities = await inspectProcessIdentities([process.pid]);
      const identity = identities.get(process.pid);

      expect(identity).toBeDefined();
      expect(
        processExecutablePathsEqual(
          identity!.executablePath,
          realpathSync.native(process.execPath),
        ),
      ).toBe(true);
      expect(
        Math.abs(identity!.startedAtMs - currentProcessStartedAtMs()),
      ).toBeLessThan(2_000);
    },
  );

  it("derives a stable start timestamp from wall time and uptime", () => {
    expect(currentProcessStartedAtMs(10_000, 2.5)).toBe(7_500);
  });
});
