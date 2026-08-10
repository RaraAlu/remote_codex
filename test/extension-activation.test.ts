import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controller: null as null | {
    initialize: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  },
  configurationListener: null as null | ((event: { affectsConfiguration(key: string): boolean }) => void),
  extensionVersions: new Map<string, string>(),
  extensionsListener: null as null | (() => void),
  repairViewLocation: vi.fn(async () => "repaired"),
  workspaceListener: null as null | (() => void),
  workspaceState: {
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    update: vi.fn(async () => undefined),
  },
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(async () => undefined),
    getCommands: vi.fn(async () => [
      "chatgpt.sidebarSecondaryView.focus",
      "workbench.action.resetFocusedViewLocation",
    ]),
  },
  extensions: {
    getExtension: (id: string) => {
      const version = mock.extensionVersions.get(id);
      return version
        ? {
            extensionPath: `C:/extensions/${id}-${version}`,
            packageJSON: { version },
          }
        : undefined;
    },
    onDidChange: (listener: () => void) => {
      mock.extensionsListener = listener;
      return { dispose: vi.fn() };
    },
  },
  workspace: {
    onDidChangeConfiguration: (
      listener: (event: { affectsConfiguration(key: string): boolean }) => void,
    ) => {
      mock.configurationListener = listener;
      return { dispose: vi.fn() };
    },
    onDidChangeWorkspaceFolders: (listener: () => void) => {
      mock.workspaceListener = listener;
      return { dispose: vi.fn() };
    },
  },
}));

vi.mock("../src/extension/controller.js", () => ({
  BridgeController: class {
    initialize = vi.fn(async () => undefined);
    logCodexContextDrop = vi.fn();
    shutdown = vi.fn(async () => undefined);

    constructor() {
      mock.controller = this;
    }

    registerCommands() {
      return [];
    }
  },
}));

vi.mock("../src/extension/view-location.js", () => ({
  repairCodexViewLocation: mock.repairViewLocation,
}));

import { activate, deactivate } from "../src/extension/extension.js";

describe("extension activation", () => {
  beforeEach(() => {
    mock.controller = null;
    mock.configurationListener = null;
    mock.extensionVersions = new Map([
      ["openai.chatgpt", "26.727.40816"],
      ["zkbot.codex-remote-bridge-executor", "0.2.20"],
    ]);
    mock.extensionsListener = null;
    mock.repairViewLocation.mockClear();
    mock.workspaceListener = null;
    mock.workspaceState.get.mockClear();
    mock.workspaceState.update.mockClear();
  });

  it("initializes for relevant changes, ignores extension-list churn, and awaits shutdown", async () => {
    const subscriptions: unknown[] = [];
    activate({ subscriptions, workspaceState: mock.workspaceState } as never);

    expect(mock.controller?.initialize).toHaveBeenCalledTimes(1);
    expect(mock.repairViewLocation).toHaveBeenCalledTimes(1);
    mock.workspaceListener?.();
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(2);
    mock.configurationListener?.({
      affectsConfiguration: (key) => key === "codexRemoteBridge",
    });
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(3);
    mock.extensionsListener?.();
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(3);
    mock.extensionVersions.set("openai.chatgpt", "26.727.40817");
    mock.extensionsListener?.();
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(4);
    mock.extensionsListener?.();
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(4);
    mock.extensionVersions.set("zkbot.codex-remote-bridge-executor", "0.2.21");
    mock.extensionsListener?.();
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(5);
    expect(subscriptions).toHaveLength(4);
    const activeController = mock.controller;
    await deactivate();
    expect(activeController?.shutdown).toHaveBeenCalledTimes(1);
  });
});
