import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controller: null as null | {
    initialize: ReturnType<typeof vi.fn>;
  },
  configurationListener: null as null | ((event: { affectsConfiguration(key: string): boolean }) => void),
  workspaceListener: null as null | (() => void),
}));

vi.mock("vscode", () => ({
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

    constructor() {
      mock.controller = this;
    }

    registerCommands() {
      return [];
    }
  },
}));

import { activate } from "../src/extension/extension.js";

describe("extension activation", () => {
  beforeEach(() => {
    mock.controller = null;
    mock.configurationListener = null;
    mock.workspaceListener = null;
  });

  it("initializes immediately and retries when the remote workspace or bridge settings change", () => {
    const subscriptions: unknown[] = [];
    activate({ subscriptions } as never);

    expect(mock.controller?.initialize).toHaveBeenCalledTimes(1);
    mock.workspaceListener?.();
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(2);
    mock.configurationListener?.({
      affectsConfiguration: (key) => key === "codexRemoteBridge",
    });
    expect(mock.controller?.initialize).toHaveBeenCalledTimes(3);
    expect(subscriptions).toHaveLength(3);
  });
});
