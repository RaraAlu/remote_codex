import { homedir } from "node:os";
import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  auditWrite: vi.fn(async () => undefined),
  executeCommand: vi.fn(async () => undefined),
  installShim: vi.fn(async () => "/managed/codex-bridge-shim.cjs"),
  inlineMentionEnable: vi.fn(async () => ({
    status: "patched",
    changed: true,
    extensionVersion: "1.0.0",
    targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
  })),
  inlineMentionRestore: vi.fn(async () => ({
    status: "restored",
    changed: true,
    extensionVersion: "1.0.0",
    targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
  })),
  officialExtension: vi.fn<() => unknown>(() => {
    throw new Error("official extension must not be queried before reload");
  }),
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  saveConfig: vi.fn(async () => undefined),
  showOpenDialog: vi.fn(async () => undefined),
  settingsConfigure: vi.fn(async () => true),
  settingsHasManaged: vi.fn(() => false),
  settingsRepair: vi.fn(async () => ({ changed: false, reloadRequired: false })),
  settingsUpdate: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  warningResponse: "Configure",
  transportStart: vi.fn(async () => {
    throw new Error("transport must not start before reload");
  }),
  workbenchEnable: vi.fn(async () => ({
    status: "patched",
    changed: true,
    targetPath: "/opt/code/workbench.js",
  })),
  workbenchNeedsElevation: vi.fn(async () => false),
  workbenchPkexec: vi.fn(async () => undefined),
  workbenchRestore: vi.fn(async () => ({
    status: "restored",
    changed: true,
    targetPath: "/opt/code/workbench.js",
  })),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  StatusBarAlignment: { Left: 1 },
  Uri: {
    file: (path: string) => ({ fsPath: path, scheme: "file" }),
  },
  commands: {
    executeCommand: mock.executeCommand,
    registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
      mock.registeredCommands.set(command, callback);
      return { dispose: vi.fn() };
    },
  },
  env: {
    appRoot: "/opt/code/resources/app",
    machineId: "local-machine",
    remoteName: "ssh-remote",
  },
  extensions: {
    getExtension: mock.officialExtension,
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    }),
    createStatusBarItem: () => ({
      dispose: vi.fn(),
      hide: vi.fn(),
      show: vi.fn(),
    }),
    showErrorMessage: mock.showErrorMessage,
    showInformationMessage: mock.showInformationMessage,
    showOpenDialog: mock.showOpenDialog,
    showWarningMessage: vi.fn(async () => mock.warningResponse),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(_key: string, fallback?: T) => fallback,
      update: mock.settingsUpdate,
    }),
    registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
    workspaceFolders: [{ uri: { path: "/home/unitree/rl_sar" } }],
  },
}));

vi.mock("../src/core/audit-log.js", () => ({
  AuditLog: class {
    write = mock.auditWrite;
  },
}));

vi.mock("../src/core/config.js", () => ({
  defaultRemotePrimaryRoot: (path: string) => ({
    displayName: "rl_sar",
    id: "remote-primary",
    path,
    role: "primary",
    target: "remote",
  }),
  parseBridgeConfig: (value: unknown) => value,
}));

vi.mock("../src/core/config-store.js", () => ({
  loadBridgeConfig: vi.fn(),
  saveBridgeConfig: mock.saveConfig,
}));

vi.mock("../src/core/local-workspace-context.js", () => ({
  clearLocalWorkspaceContext: vi.fn(async () => undefined),
  localWorkspaceContextPath: () => "/tmp/codex-bridge-local-workspace.json",
  publishLocalWorkspaceRoot: vi.fn(() => null),
  saveLocalWorkspaceContext: vi.fn(async () => undefined),
}));

vi.mock("../src/extension/remote-context.js", () => ({
  detectRemoteWorkspace: () => ({
    host: "g1_1",
    workspaceRoot: "/home/unitree/rl_sar",
  }),
}));

vi.mock("../src/extension/settings-manager.js", () => ({
  OfficialSettingsManager: class {
    configure = mock.settingsConfigure;
    hasManagedExecutable = mock.settingsHasManaged;
    repairManagedExecutable = mock.settingsRepair;
  },
}));

vi.mock("../src/extension/shim-executable.js", () => ({
  installOfficialShimLauncher: mock.installShim,
  installShimExecutable: mock.installShim,
}));

vi.mock("../src/extension/vscode-transport-server.js", () => ({
  VsCodeTransportServer: class {
    close = vi.fn(async () => undefined);
    dispose = vi.fn();
    start = mock.transportStart;
  },
}));

vi.mock("../src/extension/workbench-drop-compatibility.js", () => ({
  enableWorkbenchDropCompatibility: mock.workbenchEnable,
  inspectWorkbenchDropCompatibility: vi.fn(async () => ({
    status: "disabled",
    changed: false,
    targetPath: "/opt/code/workbench.js",
  })),
  replaceWorkbenchAssetWithPkexec: mock.workbenchPkexec,
  restoreWorkbenchDropCompatibility: mock.workbenchRestore,
  workbenchDropTargetNeedsElevation: mock.workbenchNeedsElevation,
}));

vi.mock("../src/extension/codex-inline-mention-compatibility.js", () => ({
  enableCodexInlineMentionCompatibility: mock.inlineMentionEnable,
  inspectCodexInlineMentionCompatibility: vi.fn(async () => ({
    status: "disabled",
    changed: false,
    extensionVersion: "1.0.0",
    targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
  })),
  restoreCodexInlineMentionCompatibility: mock.inlineMentionRestore,
}));

import { BridgeController } from "../src/extension/controller.js";

function context(): vscode.ExtensionContext {
  return {
    asAbsolutePath: (path: string) => path,
    extension: {
      packageJSON: { version: "0.3.10" },
    },
    globalState: {
      get: () => undefined,
      update: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext;
}

describe("BridgeController restored-state configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.officialExtension.mockImplementation(() => {
      throw new Error("official extension must not be queried before reload");
    });
    mock.registeredCommands.clear();
    mock.settingsConfigure.mockResolvedValue(true);
    mock.settingsHasManaged.mockReturnValue(false);
    mock.settingsRepair.mockResolvedValue({ changed: false, reloadRequired: false });
    mock.warningResponse = "Configure";
    mock.inlineMentionEnable.mockClear();
    mock.inlineMentionRestore.mockClear();
    mock.workbenchEnable.mockClear();
    mock.workbenchNeedsElevation.mockClear();
    mock.workbenchNeedsElevation.mockResolvedValue(false);
    mock.workbenchRestore.mockClear();
  });

  it("restores UI settings and reloads before resolving the official runtime", async () => {
    const controller = new BridgeController(context());

    await controller.configure();

    expect(mock.saveConfig).toHaveBeenCalledTimes(1);
    expect(mock.settingsConfigure).toHaveBeenCalledWith("/managed/codex-bridge-shim.cjs");
    expect(mock.settingsUpdate).toHaveBeenCalledWith("autoInitialize", true, 1);
    expect(mock.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(mock.officialExtension).not.toHaveBeenCalled();
    expect(mock.transportStart).not.toHaveBeenCalled();
    expect(mock.settingsConfigure.mock.invocationCallOrder[0]).toBeLessThan(
      mock.executeCommand.mock.invocationCallOrder[0]!,
    );
  });

  it("bootstraps UI settings before automatic official runtime detection", async () => {
    const controller = new BridgeController(context());

    await controller.initialize();

    expect(mock.settingsConfigure).toHaveBeenCalledWith("/managed/codex-bridge-shim.cjs");
    expect(mock.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(mock.officialExtension).not.toHaveBeenCalled();
    expect(mock.transportStart).not.toHaveBeenCalled();
  });

  it("does not report reload cancellation as a settings bootstrap failure", async () => {
    mock.executeCommand.mockRejectedValueOnce(
      Object.assign(new Error("Canceled"), { name: "Canceled" }),
    );
    const controller = new BridgeController(context());

    await controller.initialize();

    expect(mock.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(mock.showErrorMessage).not.toHaveBeenCalled();
    expect(mock.officialExtension).not.toHaveBeenCalled();
  });

  it("continues startup without another reload after a managed Shim content update", async () => {
    mock.settingsHasManaged.mockReturnValue(true);
    mock.settingsRepair.mockResolvedValue({ changed: true, reloadRequired: false });
    const controller = new BridgeController(context());

    await controller.initialize();

    expect(mock.settingsRepair).toHaveBeenCalledWith("/managed/codex-bridge-shim.cjs");
    expect(mock.executeCommand).not.toHaveBeenCalled();
    expect(mock.officialExtension).toHaveBeenCalledTimes(1);
  });

  it("still reloads before startup when the official extension host placement changes", async () => {
    mock.settingsHasManaged.mockReturnValue(true);
    mock.settingsRepair.mockResolvedValue({ changed: true, reloadRequired: true });
    const controller = new BridgeController(context());

    await controller.initialize();

    expect(mock.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(mock.officialExtension).not.toHaveBeenCalled();
  });

  it("registers local root authorization and revocation commands", () => {
    const controller = new BridgeController(context());

    controller.registerCommands();

    expect(mock.registeredCommands.has("codexRemoteBridge.authorizeLocalRoot")).toBe(true);
    expect(mock.registeredCommands.has("codexRemoteBridge.revokeLocalRoot")).toBe(true);
    expect(mock.registeredCommands.has("codexRemoteBridge.addRemoteFileContext")).toBe(true);
    expect(
      mock.registeredCommands.has("codexRemoteBridge.addRemoteSelectionContext"),
    ).toBe(true);
    expect(mock.registeredCommands.has("codexRemoteBridge.enableWorkbenchDrop")).toBe(true);
    expect(mock.registeredCommands.has("codexRemoteBridge.disableWorkbenchDrop")).toBe(true);
  });

  it("enables the Workbench drop patch through the explicit command", async () => {
    mock.warningResponse = "Enable";
    mock.workbenchNeedsElevation.mockResolvedValue(true);
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    const controller = new BridgeController(context());

    await controller.enableWorkbenchDrop();

    expect(mock.workbenchEnable).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: "/opt/code/resources/app",
        replaceTarget: mock.workbenchPkexec,
      }),
    );
    expect(mock.inlineMentionEnable).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionPath: "/extensions/openai.chatgpt",
        extensionVersion: "1.0.0",
      }),
    );
    expect(mock.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Reload VS Code manually"),
    );
  });

  it("restores the Workbench drop patch through the explicit command", async () => {
    mock.warningResponse = "Disable";
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    const controller = new BridgeController(context());

    await controller.disableWorkbenchDrop();

    expect(mock.workbenchRestore).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: "/opt/code/resources/app" }),
    );
    expect(mock.inlineMentionRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionPath: "/extensions/openai.chatgpt",
        extensionVersion: "1.0.0",
      }),
    );
  });

  it("opens local root authorization on the local filesystem in a remote window", async () => {
    const controller = new BridgeController(context());

    await controller.authorizeLocalRoot();

    expect(mock.showOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: { fsPath: homedir(), scheme: "file" },
      openLabel: "Authorize Folder",
      title: "Authorize a local secondary root for Codex Bridge",
    });
  });
});
