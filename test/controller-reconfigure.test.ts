import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  auditWrite: vi.fn(async () => undefined),
  executeCommand: vi.fn(async () => undefined),
  installShim: vi.fn(async () => "/managed/codex-bridge-shim.cjs"),
  officialExtension: vi.fn(() => {
    throw new Error("official extension must not be queried before reload");
  }),
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  saveConfig: vi.fn(async () => undefined),
  settingsConfigure: vi.fn(async () => true),
  settingsUpdate: vi.fn(async () => undefined),
  transportStart: vi.fn(async () => {
    throw new Error("transport must not start before reload");
  }),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  StatusBarAlignment: { Left: 1 },
  commands: {
    executeCommand: mock.executeCommand,
    registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
      mock.registeredCommands.set(command, callback);
      return { dispose: vi.fn() };
    },
  },
  env: {
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
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(async () => "Configure"),
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

vi.mock("../src/extension/remote-context.js", () => ({
  detectRemoteWorkspace: () => ({
    host: "g1_1",
    workspaceRoot: "/home/unitree/rl_sar",
  }),
}));

vi.mock("../src/extension/settings-manager.js", () => ({
  OfficialSettingsManager: class {
    configure = mock.settingsConfigure;
    hasManagedExecutable = vi.fn(() => false);
  },
}));

vi.mock("../src/extension/shim-executable.js", () => ({
  installShimExecutable: mock.installShim,
}));

vi.mock("../src/extension/vscode-transport-server.js", () => ({
  VsCodeTransportServer: class {
    close = vi.fn(async () => undefined);
    dispose = vi.fn();
    start = mock.transportStart;
  },
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
    mock.registeredCommands.clear();
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

  it("registers local root authorization and revocation commands", () => {
    const controller = new BridgeController(context());

    controller.registerCommands();

    expect(mock.registeredCommands.has("codexRemoteBridge.authorizeLocalRoot")).toBe(true);
    expect(mock.registeredCommands.has("codexRemoteBridge.revokeLocalRoot")).toBe(true);
  });
});
