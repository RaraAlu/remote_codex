import { homedir } from "node:os";
import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  auditWrite: vi.fn(async () => undefined),
  attachDrop: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    attachedCount: 1,
    directoryCount: 1,
    duplicateCount: 0,
    failedCount: 0,
    fileCount: 0,
    firstFailure: null,
    localCount: 1,
    remoteCount: 0,
  })),
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
  inlineMentionInspect: vi.fn(async () => ({
    status: "disabled",
    changed: false,
    extensionVersion: "1.0.0",
    targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
  })),
  localRootAuthorize: vi.fn(async () => ({
    displayName: "reference",
    id: "local-reference",
    path: "/local/reference",
    role: "secondary",
    target: "local",
  })),
  localDropAutomaticAuthorization: vi.fn(() => false),
  localDropAutomaticAuthorizationSet: vi.fn(async () => undefined),
  localRootContaining: vi.fn(async () => undefined as unknown),
  localRoots: vi.fn(() => [] as unknown[]),
  officialExtension: vi.fn<() => unknown>(() => {
    throw new Error("official extension must not be queried before reload");
  }),
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  parsedDrop: {
    resources: [] as unknown[],
    source: "system-file-manager",
  },
  saveConfig: vi.fn(async () => undefined),
  showOpenDialog: vi.fn(async () => undefined),
  settingsConfigure: vi.fn(async () => true),
  settingsHasManaged: vi.fn(() => false),
  settingsRepair: vi.fn(async () => ({ changed: false, reloadRequired: false })),
  settingsUpdate: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(async () => undefined as string | undefined),
  warningResponse: "Configure" as string | undefined,
  transportStart: vi.fn(async () => {
    throw new Error("transport must not start before reload");
  }),
  workbenchEnable: vi.fn(async () => ({
    status: "patched",
    changed: true,
    targetPath: "/opt/code/workbench.js",
  })),
  workbenchNeedsElevation: vi.fn(async () => false),
  workbenchInspect: vi.fn(async () => ({
    status: "disabled",
    changed: false,
    targetPath: "/opt/code/workbench.js",
  })),
  workbenchPkexec: vi.fn(async () => undefined),
  workbenchRestore: vi.fn(async () => ({
    status: "restored",
    changed: true,
    targetPath: "/opt/code/workbench.js",
  })),
  workspaceStat: vi.fn(async () => ({ ctime: 0, mtime: 0, size: 0, type: 2 })),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  StatusBarAlignment: { Left: 1 },
  FileType: { Directory: 2, File: 1 },
  Uri: {
    file: (path: string) => ({
      authority: "",
      fragment: "",
      fsPath: path,
      path,
      scheme: "file",
      toString: () => `file://${path}`,
      with: () => ({ toString: () => `file://${path}` }),
    }),
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
  version: "1.126.0",
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
    showWarningMessage: mock.showWarningMessage,
    setStatusBarMessage: vi.fn(),
  },
  workspace: {
    fs: {
      stat: mock.workspaceStat,
    },
    getConfiguration: (section: string) => ({
      get: <T>(_key: string, fallback?: T) => fallback,
      update: mock.settingsUpdate,
    }),
    registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
    workspaceFolders: [{ uri: { path: "/home/unitree/rl_sar" } }],
  },
}));

vi.mock("../src/extension/codex-context-drop.js", () => ({
  attachDroppedResourcesToCodex: mock.attachDrop,
  parseWorkbenchDropPayload: vi.fn(() => mock.parsedDrop),
}));

vi.mock("../src/extension/local-root-authority.js", () => ({
  LocalRootAuthority: class {
    authorize = mock.localRootAuthorize;
    automaticDropAuthorizationEnabled = mock.localDropAutomaticAuthorization;
    availableSlots = () => 15;
    diagnostics = vi.fn(async () => []);
    find = vi.fn(() => undefined);
    findContainingDirectory = mock.localRootContaining;
    revoke = vi.fn(async () => false);
    roots = mock.localRoots;
    setAutomaticDropAuthorizationEnabled = mock.localDropAutomaticAuthorizationSet;
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
  inspectWorkbenchDropCompatibility: mock.workbenchInspect,
  replaceWorkbenchAssetWithPkexec: mock.workbenchPkexec,
  restoreWorkbenchDropCompatibility: mock.workbenchRestore,
  workbenchDropTargetNeedsElevation: mock.workbenchNeedsElevation,
}));

vi.mock("../src/extension/codex-inline-mention-compatibility.js", () => ({
  enableCodexInlineMentionCompatibility: mock.inlineMentionEnable,
  inspectCodexInlineMentionCompatibility: mock.inlineMentionInspect,
  restoreCodexInlineMentionCompatibility: mock.inlineMentionRestore,
}));

import { BridgeController } from "../src/extension/controller.js";

const globalStateValues = new Map<string, unknown>();

function context(): vscode.ExtensionContext {
  return {
    asAbsolutePath: (path: string) => path,
    extension: {
      packageJSON: { version: "0.3.10" },
    },
    globalState: {
      get: (key: string) => globalStateValues.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          globalStateValues.delete(key);
        } else {
          globalStateValues.set(key, value);
        }
      },
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
    globalStateValues.clear();
    mock.settingsConfigure.mockResolvedValue(true);
    mock.settingsHasManaged.mockReturnValue(false);
    mock.settingsRepair.mockResolvedValue({ changed: false, reloadRequired: false });
    mock.warningResponse = "Configure";
    mock.showWarningMessage.mockImplementation(async () => mock.warningResponse);
    mock.inlineMentionEnable.mockClear();
    mock.inlineMentionInspect.mockReset();
    mock.inlineMentionInspect.mockResolvedValue({
      status: "disabled",
      changed: false,
      extensionVersion: "1.0.0",
      targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
    });
    mock.inlineMentionRestore.mockClear();
    mock.attachDrop.mockClear();
    mock.localRootAuthorize.mockClear();
    mock.localDropAutomaticAuthorization.mockReset();
    mock.localDropAutomaticAuthorization.mockReturnValue(false);
    mock.localDropAutomaticAuthorizationSet.mockReset();
    mock.localDropAutomaticAuthorizationSet.mockResolvedValue(undefined);
    mock.localRootContaining.mockReset();
    mock.localRootContaining.mockResolvedValue(undefined);
    mock.localRoots.mockReset();
    mock.localRoots.mockReturnValue([]);
    mock.parsedDrop.resources = [];
    mock.parsedDrop.source = "system-file-manager";
    mock.workbenchEnable.mockClear();
    mock.workbenchInspect.mockReset();
    mock.workbenchInspect.mockResolvedValue({
      status: "disabled",
      changed: false,
      targetPath: "/opt/code/workbench.js",
    });
    mock.workbenchNeedsElevation.mockClear();
    mock.workbenchNeedsElevation.mockResolvedValue(false);
    mock.workbenchRestore.mockClear();
    mock.workspaceStat.mockReset();
    mock.workspaceStat.mockResolvedValue({ ctime: 0, mtime: 0, size: 0, type: 2 });
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
      expect.stringContaining("Reloading VS Code automatically"),
    );
    expect(mock.localDropAutomaticAuthorizationSet).toHaveBeenCalledWith(true);
    expect(mock.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("offers compatible native drop access once and reloads after approval", async () => {
    mock.warningResponse = "Enable";
    mock.workbenchNeedsElevation.mockResolvedValue(true);
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    const controller = new BridgeController(context());

    await controller.offerWorkbenchDropOnboarding();
    await controller.offerWorkbenchDropOnboarding();

    expect(mock.workbenchInspect).toHaveBeenCalledOnce();
    expect(mock.inlineMentionInspect).toHaveBeenCalledOnce();
    expect(mock.workbenchEnable).toHaveBeenCalledOnce();
    expect(mock.workbenchEnable).toHaveBeenCalledWith(
      expect.objectContaining({ replaceTarget: mock.workbenchPkexec }),
    );
    expect(mock.executeCommand).toHaveBeenCalledTimes(1);
    expect(mock.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("rolls back automatic local path consent when native drop enable fails", async () => {
    mock.warningResponse = "Enable";
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    mock.workbenchEnable.mockRejectedValueOnce(new Error("patch failed"));
    const controller = new BridgeController(context());

    await controller.enableWorkbenchDrop();

    expect(mock.localDropAutomaticAuthorizationSet.mock.calls).toEqual([
      [true],
      [false],
    ]);
    expect(mock.executeCommand).not.toHaveBeenCalled();
    expect(mock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("patch failed"),
    );
  });

  it("does not repeat automatic native drop consent after dismissal", async () => {
    mock.warningResponse = undefined;
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    const controller = new BridgeController(context());

    await controller.offerWorkbenchDropOnboarding();
    await controller.offerWorkbenchDropOnboarding();

    expect(mock.workbenchInspect).toHaveBeenCalledOnce();
    expect(mock.inlineMentionInspect).toHaveBeenCalledOnce();
    expect(mock.workbenchEnable).not.toHaveBeenCalled();
    expect(mock.executeCommand).not.toHaveBeenCalled();
  });

  it("does not request access when both native drop assets and automatic path consent are already enabled", async () => {
    mock.workbenchInspect.mockResolvedValue({
      status: "already-patched",
      changed: false,
      targetPath: "/opt/code/workbench.js",
    });
    mock.inlineMentionInspect.mockResolvedValue({
      status: "already-patched",
      changed: false,
      extensionVersion: "1.0.0",
      targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
    });
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    mock.localDropAutomaticAuthorization.mockReturnValue(true);
    const controller = new BridgeController(context());

    await controller.offerWorkbenchDropOnboarding();

    expect(mock.workbenchEnable).not.toHaveBeenCalled();
    expect(mock.inlineMentionEnable).not.toHaveBeenCalled();
    expect(mock.executeCommand).not.toHaveBeenCalled();
  });

  it("offers automatic local path consent when native drop assets are already patched", async () => {
    mock.warningResponse = "Enable";
    mock.workbenchInspect.mockResolvedValue({
      status: "already-patched",
      changed: false,
      targetPath: "/opt/code/workbench.js",
    });
    mock.inlineMentionInspect.mockResolvedValue({
      status: "already-patched",
      changed: false,
      extensionVersion: "1.0.0",
      targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
    });
    mock.inlineMentionEnable.mockResolvedValueOnce({
      status: "already-patched",
      changed: false,
      extensionVersion: "1.0.0",
      targetPath: "/extensions/openai.chatgpt/webview/assets/app.js",
    });
    mock.workbenchEnable.mockResolvedValueOnce({
      status: "already-patched",
      changed: false,
      targetPath: "/opt/code/workbench.js",
    });
    mock.officialExtension.mockReturnValue({
      extensionPath: "/extensions/openai.chatgpt",
      packageJSON: { version: "1.0.0" },
    });
    const controller = new BridgeController(context());

    await controller.offerWorkbenchDropOnboarding();

    expect(mock.showWarningMessage).toHaveBeenCalledOnce();
    expect(mock.localDropAutomaticAuthorizationSet).toHaveBeenCalledWith(true);
    expect(mock.executeCommand).not.toHaveBeenCalled();
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
    expect(mock.localDropAutomaticAuthorizationSet).toHaveBeenCalledWith(false);
  });

  it("opens local root authorization on the local filesystem in a remote window", async () => {
    const controller = new BridgeController(context());

    await controller.authorizeLocalRoot();

    expect(mock.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: expect.objectContaining({ fsPath: homedir(), scheme: "file" }),
        openLabel: "Authorize Folder",
        title: "Authorize a local secondary root for Codex Bridge",
      }),
    );
  });

  it("asks before authorizing a locally dropped directory in a Remote SSH window", async () => {
    mock.warningResponse = "Authorize Local Path";
    mock.parsedDrop.resources = [
      {
        authority: "",
        fragment: "",
        fsPath: "/local/reference",
        path: "/local/reference",
        scheme: "file",
        toString: () => "file:///local/reference",
        with: () => ({ toString: () => "file:///local/reference" }),
      },
    ];
    const controller = new BridgeController(context());

    await controller.addWorkbenchCodexContext({ schemaVersion: 1 });

    expect(mock.localRootAuthorize).toHaveBeenCalledWith("/local/reference");
    expect(mock.saveConfig).toHaveBeenCalled();
    expect(mock.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "local_root.authorize_drop",
        rootId: "local-reference",
        target: "local",
      }),
    );
    expect(mock.attachDrop).not.toHaveBeenCalled();
    expect(mock.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("drop the resource again"),
      "Reload Window",
    );
  });

  it("authorizes the containing folder before adding a local file from the system file manager", async () => {
    mock.warningResponse = "Authorize Local Path";
    mock.workspaceStat.mockResolvedValue({ ctime: 0, mtime: 0, size: 12, type: 1 });
    mock.parsedDrop.resources = [
      {
        authority: "",
        fragment: "",
        fsPath: "/local/reference/manual.pdf",
        path: "/local/reference/manual.pdf",
        scheme: "file",
        toString: () => "file:///local/reference/manual.pdf",
        with: () => ({ toString: () => "file:///local/reference/manual.pdf" }),
      },
    ];
    const controller = new BridgeController(context());

    await controller.addWorkbenchCodexContext({ schemaVersion: 1 });

    expect(mock.localRootContaining).toHaveBeenCalledWith("/local/reference");
    expect(mock.localRootAuthorize).toHaveBeenCalledWith("/local/reference");
    expect(mock.attachDrop).not.toHaveBeenCalled();
  });

  it("automatically authorizes an explicitly dropped local path after drop-surface consent", async () => {
    mock.warningResponse = undefined;
    mock.localDropAutomaticAuthorization.mockReturnValue(true);
    mock.workspaceStat.mockResolvedValue({ ctime: 0, mtime: 0, size: 12, type: 1 });
    mock.parsedDrop.resources = [
      {
        authority: "",
        fragment: "",
        fsPath: "/local/reference/manual.pdf",
        path: "/local/reference/manual.pdf",
        scheme: "file",
        toString: () => "file:///local/reference/manual.pdf",
        with: () => ({ toString: () => "file:///local/reference/manual.pdf" }),
      },
    ];
    const controller = new BridgeController(context());

    await controller.addWorkbenchCodexContext({ schemaVersion: 1 });

    expect(mock.showWarningMessage).not.toHaveBeenCalled();
    expect(mock.localRootAuthorize).toHaveBeenCalledWith("/local/reference");
    expect(mock.auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "local_root.authorize_drop",
        details: { authorizationMode: "drop-surface-consent" },
      }),
    );
  });

  it("adds an authorized local file through the uniform inline mention path", async () => {
    mock.workspaceStat.mockResolvedValue({ ctime: 0, mtime: 0, size: 12, type: 1 });
    const resource = {
      authority: "",
      fragment: "",
      fsPath: "/local/reference/main.py",
      path: "/local/reference/main.py",
      scheme: "file",
      toString: () => "file:///local/reference/main.py",
      with: () => ({ toString: () => "file:///local/reference/main.py" }),
    };
    mock.parsedDrop.resources = [resource];
    mock.localRootContaining.mockResolvedValue({
      id: "local-reference",
      path: "/local/reference",
      role: "secondary",
      target: "local",
    });
    const controller = new BridgeController(context());

    await controller.addWorkbenchCodexContext({ schemaVersion: 1 });

    expect(mock.localRootContaining).toHaveBeenCalledWith("/local/reference");
    expect(mock.attachDrop).toHaveBeenCalledOnce();
    expect(mock.attachDrop).toHaveBeenCalledWith([resource], {
      log: expect.any(Function),
    });
  });
});
