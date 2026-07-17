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

  async configure(shimPath: string): Promise<void> {
    const existingBackup = this.#context.globalState.get<OfficialSettingsBackup>(BACKUP_KEY);
    if (!existingBackup) {
      await this.#context.globalState.update(BACKUP_KEY, {
        chatgptCliExecutable: snapshot("chatgpt", "cliExecutable"),
        remoteExtensionKind: snapshot("remote", "extensionKind"),
      } satisfies OfficialSettingsBackup);
    }

    const currentKinds =
      vscode.workspace.getConfiguration("remote").get<Record<string, string[]>>("extensionKind") ??
      {};
    await vscode.workspace.getConfiguration("remote").update(
      "extensionKind",
      {
        ...currentKinds,
        "openai.chatgpt": ["ui"],
      },
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace
      .getConfiguration("chatgpt")
      .update("cliExecutable", shimPath, vscode.ConfigurationTarget.Global);
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
