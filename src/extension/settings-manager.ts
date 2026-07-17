import * as vscode from "vscode";

const BACKUP_KEY = "codexRemoteBridge.officialSettingsBackup.v1";

interface SettingSnapshot {
  hasGlobalValue: boolean;
  value: unknown;
}

interface OfficialSettingsBackup {
  chatgptCliExecutable: SettingSnapshot;
  remoteExtensionKind: SettingSnapshot;
}

export interface OfficialSettingsStatus {
  cliExecutable: boolean;
  extensionKind: boolean;
  configured: boolean;
}

function snapshot(section: string, key: string): SettingSnapshot {
  const inspected = vscode.workspace.getConfiguration(section).inspect(key);
  return {
    hasGlobalValue: inspected?.globalValue !== undefined,
    value: inspected?.globalValue,
  };
}

async function restoreSnapshot(
  section: string,
  key: string,
  saved: SettingSnapshot,
): Promise<void> {
  await vscode.workspace
    .getConfiguration(section)
    .update(
      key,
      saved.hasGlobalValue ? saved.value : undefined,
      vscode.ConfigurationTarget.Global,
    );
}

export class OfficialSettingsManager {
  readonly #context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
  }

  status(shimPath: string): OfficialSettingsStatus {
    const cliExecutable =
      vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable") === shimPath;
    const currentKinds =
      vscode.workspace.getConfiguration("remote").get<Record<string, string[]>>("extensionKind") ??
      {};
    const codexKinds = currentKinds["openai.chatgpt"];
    const extensionKind =
      Array.isArray(codexKinds) && codexKinds.length === 1 && codexKinds[0] === "ui";
    return {
      cliExecutable,
      extensionKind,
      configured: cliExecutable && extensionKind,
    };
  }

  async configure(shimPath: string): Promise<boolean> {
    const before = this.status(shimPath);
    if (before.configured) {
      return false;
    }

    const existingBackup = this.#context.globalState.get<OfficialSettingsBackup>(BACKUP_KEY);
    if (!existingBackup) {
      await this.#context.globalState.update(BACKUP_KEY, {
        chatgptCliExecutable: snapshot("chatgpt", "cliExecutable"),
        remoteExtensionKind: snapshot("remote", "extensionKind"),
      } satisfies OfficialSettingsBackup);
    }

    if (!before.extensionKind) {
      const currentKinds =
        vscode.workspace
          .getConfiguration("remote")
          .get<Record<string, string[]>>("extensionKind") ?? {};
      await vscode.workspace.getConfiguration("remote").update(
        "extensionKind",
        {
          ...currentKinds,
          "openai.chatgpt": ["ui"],
        },
        vscode.ConfigurationTarget.Global,
      );
    }
    if (!before.cliExecutable) {
      await vscode.workspace
        .getConfiguration("chatgpt")
        .update("cliExecutable", shimPath, vscode.ConfigurationTarget.Global);
    }

    if (!this.status(shimPath).configured) {
      throw new Error(
        "Workspace or remote settings override the required Codex Bridge global settings",
      );
    }
    return true;
  }

  async restore(): Promise<boolean> {
    const backup = this.#context.globalState.get<OfficialSettingsBackup>(BACKUP_KEY);
    if (!backup) {
      return false;
    }
    await restoreSnapshot("chatgpt", "cliExecutable", backup.chatgptCliExecutable);
    await restoreSnapshot("remote", "extensionKind", backup.remoteExtensionKind);
    await this.#context.globalState.update(BACKUP_KEY, undefined);
    return true;
  }
}
