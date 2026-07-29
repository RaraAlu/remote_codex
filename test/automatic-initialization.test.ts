import { describe, expect, it } from "vitest";
import { planAutomaticInitialization } from "../src/extension/automatic-initialization.js";

const idleInput = {
  autoInitialize: false,
  autoSuppressed: false,
  externalCliIntegration: false,
  managedExecutable: false,
  remoteName: "ssh-remote",
  workspaceFolderCount: 1,
} as const;

describe("planAutomaticInitialization", () => {
  it("keeps a restored Bridge idle without validating the official runtime", () => {
    expect(planAutomaticInitialization(idleInput)).toEqual({
      connectRemote: false,
      reconcileExternalCli: false,
      refreshOfficialRuntime: false,
      repairManagedExecutable: false,
    });
  });

  it("repairs a managed launcher even when automatic connection is disabled", () => {
    expect(
      planAutomaticInitialization({
        ...idleInput,
        managedExecutable: true,
      }),
    ).toEqual({
      connectRemote: false,
      reconcileExternalCli: false,
      refreshOfficialRuntime: true,
      repairManagedExecutable: true,
    });
  });

  it("reconciles enabled external CLI integration independently", () => {
    expect(
      planAutomaticInitialization({
        ...idleInput,
        externalCliIntegration: true,
      }),
    ).toEqual({
      connectRemote: false,
      reconcileExternalCli: true,
      refreshOfficialRuntime: false,
      repairManagedExecutable: false,
    });
  });

  it("connects an eligible Remote SSH workspace automatically", () => {
    expect(
      planAutomaticInitialization({
        ...idleInput,
        autoInitialize: true,
      }),
    ).toEqual({
      connectRemote: true,
      reconcileExternalCli: false,
      refreshOfficialRuntime: false,
      repairManagedExecutable: false,
    });
  });
});
