export interface AutomaticInitializationInput {
  autoInitialize: boolean;
  autoSuppressed: boolean;
  externalCliIntegration: boolean;
  managedExecutable: boolean;
  remoteName: string | undefined;
  workspaceFolderCount: number;
}

export interface AutomaticInitializationPlan {
  connectRemote: boolean;
  reconcileExternalCli: boolean;
  refreshOfficialRuntime: boolean;
  repairManagedExecutable: boolean;
}

export function planAutomaticInitialization(
  input: AutomaticInitializationInput,
): AutomaticInitializationPlan {
  const connectRemote =
    !input.autoSuppressed &&
    input.remoteName === "ssh-remote" &&
    input.autoInitialize &&
    input.workspaceFolderCount > 0;
  return {
    connectRemote,
    reconcileExternalCli: input.externalCliIntegration,
    refreshOfficialRuntime: input.managedExecutable,
    repairManagedExecutable: input.managedExecutable,
  };
}
