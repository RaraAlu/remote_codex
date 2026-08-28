export interface AppServerSessionBootstrapIdentity {
  bridgeVersion: string;
  host: string;
  vscodeVersion: string;
  workspaceRoot: string;
}

export function appServerSessionBootstrapFingerprint(
  identity: AppServerSessionBootstrapIdentity,
): string {
  return JSON.stringify(identity);
}

export function shouldReloadForAppServerSession(
  shimStarted: boolean,
  previousFingerprint: string | undefined,
  currentFingerprint: string,
): boolean {
  return !shimStarted && previousFingerprint !== currentFingerprint;
}
