import { describe, expect, it } from "vitest";
import {
  currentControllerTarget,
  retainedArtifactNames,
  validateControllerEntryNames,
  validateStageManifest,
} from "../scripts/package-artifacts.mjs";

const versions = {
  controllerVersion: "0.3.22",
  executorVersion: "0.2.13",
};

function manifest(target: "linux-x64" | "win32-x64") {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-24T00:00:00.000Z",
    sourceArch: "x64",
    sourcePlatform: target === "win32-x64" ? "win32" : "linux",
    target,
    ...versions,
    files: [
      {
        name: `codex-remote-bridge-${versions.controllerVersion}-${target}.vsix`,
        role: "controller",
        sha256: "a".repeat(64),
        size: 100,
      },
      {
        name:
          `codex-remote-bridge-executor-${versions.executorVersion}-linux-x64.vsix`,
        role: "executor",
        sha256: "b".repeat(64),
        size: 50,
      },
    ],
  };
}

describe("native package artifact workflow", () => {
  it("only assigns native x64 Controller targets", () => {
    expect(currentControllerTarget("linux", "x64")).toBe("linux-x64");
    expect(currentControllerTarget("win32", "x64")).toBe("win32-x64");
    expect(currentControllerTarget("darwin", "x64")).toBeNull();
    expect(currentControllerTarget("linux", "arm64")).toBeNull();
  });

  it("retains only the current dual Controller and matching Executor VSIX names", () => {
    expect([...retainedArtifactNames("0.3.22", "0.2.13")].sort()).toEqual([
      "codex-remote-bridge-0.3.22-linux-x64.vsix",
      "codex-remote-bridge-0.3.22-win32-x64.vsix",
      "codex-remote-bridge-executor-0.2.13-linux-x64.vsix",
      "codex-remote-bridge-executor.vsix",
    ]);
  });

  it("enforces launcher isolation in each Controller VSIX", () => {
    const common = ["extension/dist/codex-remote-bridge-executor.vsix"];
    expect(() =>
      validateControllerEntryNames(
        [...common, "extension/dist/codex-bridge-shim"],
        "linux-x64",
      ),
    ).not.toThrow();
    expect(() =>
      validateControllerEntryNames(
        [...common, "extension/dist/codex-bridge-shim.exe"],
        "win32-x64",
      ),
    ).not.toThrow();
    expect(() =>
      validateControllerEntryNames(
        [
          ...common,
          "extension/dist/codex-bridge-shim",
          "extension/dist/codex-bridge-shim.exe",
        ],
        "linux-x64",
      ),
    ).toThrow(/isolation/);
    expect(() =>
      validateControllerEntryNames(
        [
          ...common,
          "extension/dist/codex-bridge-shim",
          "extension/artifacts/controller/manifest.json",
        ],
        "linux-x64",
      ),
    ).toThrow(/staging/);
    expect(() =>
      validateControllerEntryNames(
        [
          ...common,
          "extension/dist/codex-bridge-shim",
          "extension/dist/codex-bridge-shim.cjs",
        ],
        "linux-x64",
      ),
    ).toThrow(/isolation/);
  });

  it.each(["linux-x64", "win32-x64"] as const)(
    "accepts one complete native %s manifest",
    (target) => {
      expect(
        validateStageManifest(manifest(target), { ...versions, target }),
      ).toEqual(manifest(target));
    },
  );

  it("rejects version drift, foreign-host claims, duplicate files, and unknown roles", () => {
    const wrongVersion = manifest("linux-x64");
    wrongVersion.controllerVersion = "0.3.21";
    expect(() =>
      validateStageManifest(wrongVersion, {
        ...versions,
        target: "linux-x64",
      }),
    ).toThrow(/incompatible/);

    const foreignHost = manifest("win32-x64");
    foreignHost.sourcePlatform = "linux";
    expect(() =>
      validateStageManifest(foreignHost, {
        ...versions,
        target: "win32-x64",
      }),
    ).toThrow(/incompatible/);

    const duplicate = manifest("linux-x64");
    duplicate.files[1] = { ...duplicate.files[0]! };
    expect(() =>
      validateStageManifest(duplicate, {
        ...versions,
        target: "linux-x64",
      }),
    ).toThrow(/invalid/);

    const unknownRole = manifest("linux-x64");
    unknownRole.files[0]!.role = "launcher";
    expect(() =>
      validateStageManifest(unknownRole, {
        ...versions,
        target: "linux-x64",
      }),
    ).toThrow(/invalid/);
  });
});
