export type ControllerTarget = "linux-x64" | "win32-x64";

export function currentControllerTarget(
  platform?: NodeJS.Platform,
  arch?: string,
): ControllerTarget | null;

export function retainedArtifactNames(
  controllerVersion: string,
  executorVersion: string,
): Set<string>;

export function validateControllerEntryNames(
  entries: Iterable<string>,
  target: ControllerTarget,
): void;

export function validateStageManifest<T>(
  value: T,
  expected: {
    controllerVersion: string;
    executorVersion: string;
    target: ControllerTarget;
  },
): T;

export function sha256File(path: string): Promise<string>;

export function cleanupHistoricalVersionedArtifacts(
  controllerVersion: string,
  executorVersion: string,
): Promise<void>;
