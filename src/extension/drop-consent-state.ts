import type * as vscode from "vscode";

const AUTOMATIC_DROP_AUTHORIZATION_KEY =
  "codexRemoteBridge.automaticLocalDropAuthorization.v1";

export class DropConsentState {
  readonly #state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.#state = state;
  }

  enabled(): boolean {
    return this.#state.get<boolean>(AUTOMATIC_DROP_AUTHORIZATION_KEY) === true;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#state.update(AUTOMATIC_DROP_AUTHORIZATION_KEY, enabled || undefined);
  }
}
