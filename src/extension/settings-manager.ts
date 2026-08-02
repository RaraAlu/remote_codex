import * as vscode from "vscode";
import { isBridgeShimPath } from "./shim-executable.js";

const BACKUP_KEY_V1 = "codexRemoteBridge.officialSettingsBackup.v1";
const BACKUP_KEY_V2 = "codexRemoteBridge.officialSettingsBackup.v2";
const BACKUP_KEY_V3 = "codexRemoteBridge.officialSettingsBackup.v3";
const CODEX_EXTENSION_ID = "openai.chatgpt";
const COPILOT_EXTENSION_ID = "GitHub.copilot-chat";

interface SettingSnapshot {
  hasGlobalValue: boolean;
  value: unknown;
}

interface OfficialSettingsBackupV1 {
  chatgptCliExecutable: SettingSnapshot;
  remoteExtensionKind: SettingSnapshot;
}

interface OfficialSettingsBackupV2 {
  version: 2;
  chatgptCliExecutable: SettingSnapshot;
  remoteExtensionKindHadGlobalValue: boolean;
  remoteCodexExtensionKind: SettingSnapshot;
  managedCliExecutable: string;
}

interface OfficialSettingsBackupV3 {
  version: 3;
  chatgptCliExecutable: SettingSnapshot;
  remoteExtensionKindHadGlobalValue: boolean;
  remoteCodexExtensionKind: SettingSnapshot;
  remoteCopilotExtensionKind: SettingSnapshot;
  managedCliExecutable: string;
}

export interface OfficialSettingsStatus {
  cliExecutable: boolean;
  extensionKind: boolean;
  copilotExtensionKind: boolean;
  configured: boolean;
}

export interface ManagedExecutableRepairResult {
  changed: boolean;
  reloadRequired: boolean;
}

function snapshot(section: string, key: string): SettingSnapshot {
  const inspected = vscode.workspace.getConfiguration(section).inspect(key);
  return {
    hasGlobalValue: inspected?.globalValue !== undefined,
    value: inspected?.globalValue,
  };
}

function globalExtensionKinds(): Record<string, string[]> {
  const value = vscode.workspace.getConfiguration("remote").inspect("extensionKind")?.globalValue;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, string[]>) }
    : {};
}

function isUiKind(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === "ui";
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
    const extensionKind = isUiKind(currentKinds[CODEX_EXTENSION_ID]);
    const copilotExtensionKind = isUiKind(currentKinds[COPILOT_EXTENSION_ID]);
    return {
      cliExecutable,
      extensionKind,
      copilotExtensionKind,
      configured: cliExecutable && extensionKind && copilotExtensionKind,
    };
  }

  hasManagedExecutable(): boolean {
    const current = vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable");
    const backup =
      this.#context.globalState.get<OfficialSettingsBackupV3>(BACKUP_KEY_V3) ??
      this.#context.globalState.get<OfficialSettingsBackupV2>(BACKUP_KEY_V2);
    return (
      isBridgeShimPath(current) ||
      Boolean(current && backup?.managedCliExecutable === current)
    );
  }

  async repairManagedExecutable(shimPath: string): Promise<ManagedExecutableRepairResult> {
    const current = vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable");
    const backup = await this.#loadBackup();
    const owned =
      isBridgeShimPath(current) ||
      Boolean(current && backup?.managedCliExecutable === current);
    if (!owned || this.status(shimPath).configured) {
      return { changed: false, reloadRequired: false };
    }
    const status = this.status(shimPath);
    const reloadRequired = !status.extensionKind || !status.copilotExtensionKind;
    await this.#ensureBackup(current);
    const changed = await this.#apply(shimPath);
    return { changed, reloadRequired: changed && reloadRequired };
  }

  async configure(shimPath: string): Promise<boolean> {
    if (this.status(shimPath).configured) {
      return false;
    }
    const current = vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable");
    await this.#ensureBackup(current);
    return await this.#apply(shimPath);
  }

  async restore(): Promise<boolean> {
    const backup = await this.#loadBackup();
    if (!backup) {
      return false;
    }

    await restoreSnapshot("chatgpt", "cliExecutable", backup.chatgptCliExecutable);

    const currentKinds = globalExtensionKinds();
    if (backup.remoteCodexExtensionKind.hasGlobalValue) {
      currentKinds[CODEX_EXTENSION_ID] = backup.remoteCodexExtensionKind.value as string[];
    } else {
      delete currentKinds[CODEX_EXTENSION_ID];
    }
    if (backup.remoteCopilotExtensionKind.hasGlobalValue) {
      currentKinds[COPILOT_EXTENSION_ID] = backup.remoteCopilotExtensionKind.value as string[];
    } else {
      delete currentKinds[COPILOT_EXTENSION_ID];
    }
    const nextKinds =
      Object.keys(currentKinds).length > 0 || backup.remoteExtensionKindHadGlobalValue
        ? currentKinds
        : undefined;
    await vscode.workspace
      .getConfiguration("remote")
      .update("extensionKind", nextKinds, vscode.ConfigurationTarget.Global);

    await this.#context.globalState.update(BACKUP_KEY_V3, undefined);
    await this.#context.globalState.update(BACKUP_KEY_V2, undefined);
    await this.#context.globalState.update(BACKUP_KEY_V1, undefined);
    return true;
  }

  async #apply(shimPath: string): Promise<boolean> {
    const before = this.status(shimPath);
    const backup = await this.#loadBackup();
    if (backup && backup.managedCliExecutable !== shimPath) {
      await this.#context.globalState.update(BACKUP_KEY_V3, {
        ...backup,
        managedCliExecutable: shimPath,
      } satisfies OfficialSettingsBackupV3);
    }

    if (!before.extensionKind || !before.copilotExtensionKind) {
      const currentKinds =
        vscode.workspace
          .getConfiguration("remote")
          .get<Record<string, string[]>>("extensionKind") ?? {};
      await vscode.workspace.getConfiguration("remote").update(
        "extensionKind",
        {
          ...currentKinds,
          [CODEX_EXTENSION_ID]: ["ui"],
          [COPILOT_EXTENSION_ID]: ["ui"],
        },
        vscode.ConfigurationTarget.Global,
      );
      const after = this.status(shimPath);
      if (!after.extensionKind || !after.copilotExtensionKind) {
        throw new Error(
          "Workspace or remote settings override the required Codex Bridge extension placement",
        );
      }
      return true;
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

  async #ensureBackup(currentCliExecutable: string | undefined): Promise<OfficialSettingsBackupV3> {
    const existing = await this.#loadBackup();
    if (existing) {
      return existing;
    }

    const currentKindsSnapshot = snapshot("remote", "extensionKind");
    const currentKinds =
      currentKindsSnapshot.value && typeof currentKindsSnapshot.value === "object"
        ? (currentKindsSnapshot.value as Record<string, unknown>)
        : {};
    const staleManagedPath = isBridgeShimPath(currentCliExecutable);
    const backup: OfficialSettingsBackupV3 = {
      version: 3,
      chatgptCliExecutable: staleManagedPath
        ? { hasGlobalValue: false, value: undefined }
        : snapshot("chatgpt", "cliExecutable"),
      remoteExtensionKindHadGlobalValue: currentKindsSnapshot.hasGlobalValue,
      remoteCodexExtensionKind:
        staleManagedPath && isUiKind(currentKinds[CODEX_EXTENSION_ID])
          ? { hasGlobalValue: false, value: undefined }
          : {
              hasGlobalValue: Object.hasOwn(currentKinds, CODEX_EXTENSION_ID),
              value: currentKinds[CODEX_EXTENSION_ID],
            },
      remoteCopilotExtensionKind: {
        hasGlobalValue: Object.hasOwn(currentKinds, COPILOT_EXTENSION_ID),
        value: currentKinds[COPILOT_EXTENSION_ID],
      },
      managedCliExecutable: currentCliExecutable ?? "",
    };
    await this.#context.globalState.update(BACKUP_KEY_V3, backup);
    return backup;
  }

  async #loadBackup(): Promise<OfficialSettingsBackupV3 | undefined> {
    const current = this.#context.globalState.get<OfficialSettingsBackupV3>(BACKUP_KEY_V3);
    if (current?.version === 3) {
      return current;
    }

    const previous = this.#context.globalState.get<OfficialSettingsBackupV2>(BACKUP_KEY_V2);
    if (previous?.version === 2) {
      const currentKinds = globalExtensionKinds();
      const migrated: OfficialSettingsBackupV3 = {
        ...previous,
        version: 3,
        remoteCopilotExtensionKind: {
          hasGlobalValue: Object.hasOwn(currentKinds, COPILOT_EXTENSION_ID),
          value: currentKinds[COPILOT_EXTENSION_ID],
        },
      };
      await this.#context.globalState.update(BACKUP_KEY_V3, migrated);
      await this.#context.globalState.update(BACKUP_KEY_V2, undefined);
      return migrated;
    }

    const legacy = this.#context.globalState.get<OfficialSettingsBackupV1>(BACKUP_KEY_V1);
    if (!legacy) {
      return undefined;
    }
    const legacyKinds =
      legacy.remoteExtensionKind.value && typeof legacy.remoteExtensionKind.value === "object"
        ? (legacy.remoteExtensionKind.value as Record<string, unknown>)
        : {};
    const migrated: OfficialSettingsBackupV3 = {
      version: 3,
      chatgptCliExecutable: legacy.chatgptCliExecutable,
      remoteExtensionKindHadGlobalValue: legacy.remoteExtensionKind.hasGlobalValue,
      remoteCodexExtensionKind: {
        hasGlobalValue:
          legacy.remoteExtensionKind.hasGlobalValue &&
          Object.hasOwn(legacyKinds, CODEX_EXTENSION_ID),
        value: legacyKinds[CODEX_EXTENSION_ID],
      },
      remoteCopilotExtensionKind: {
        hasGlobalValue:
          legacy.remoteExtensionKind.hasGlobalValue &&
          Object.hasOwn(legacyKinds, COPILOT_EXTENSION_ID),
        value: legacyKinds[COPILOT_EXTENSION_ID],
      },
      managedCliExecutable:
        vscode.workspace.getConfiguration("chatgpt").get<string>("cliExecutable") ?? "",
    };
    await this.#context.globalState.update(BACKUP_KEY_V3, migrated);
    await this.#context.globalState.update(BACKUP_KEY_V2, undefined);
    await this.#context.globalState.update(BACKUP_KEY_V1, undefined);
    return migrated;
  }
}
