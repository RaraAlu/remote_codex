import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  effective: new Map<string, unknown>(),
  global: new Map<string, unknown>(),
  extensionState: new Map<string, unknown>(),
  updates: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) => mock.effective.get(`${section}.${key}`),
      inspect: (key: string) => {
        const setting = `${section}.${key}`;
        return {
          globalValue: mock.global.get(setting),
        };
      },
      update: async (key: string, value: unknown) => {
        const setting = `${section}.${key}`;
        mock.updates.push({ key: setting, value });
        if (value === undefined) {
          mock.global.delete(setting);
          mock.effective.delete(setting);
        } else {
          mock.global.set(setting, value);
          mock.effective.set(setting, value);
        }
      },
    }),
  },
}));

import { OfficialSettingsManager } from "../src/extension/settings-manager.js";

function context(): vscode.ExtensionContext {
  return {
    globalState: {
      get: <T>(key: string) => mock.extensionState.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          mock.extensionState.delete(key);
        } else {
          mock.extensionState.set(key, value);
        }
      },
    },
  } as unknown as vscode.ExtensionContext;
}

describe("OfficialSettingsManager", () => {
  beforeEach(() => {
    mock.effective.clear();
    mock.global.clear();
    mock.extensionState.clear();
    mock.updates.length = 0;
  });

  it("does not rewrite or back up settings that are already effective", async () => {
    mock.effective.set("chatgpt.cliExecutable", "/extension/shim.cjs");
    mock.effective.set("remote.extensionKind", { "openai.chatgpt": ["ui"] });
    const manager = new OfficialSettingsManager(context());

    await expect(manager.configure("/extension/shim.cjs")).resolves.toBe(false);
    expect(manager.status("/extension/shim.cjs")).toEqual({
      cliExecutable: true,
      extensionKind: true,
      configured: true,
    });
    expect(mock.updates).toEqual([]);
    expect(mock.extensionState.size).toBe(0);
  });

  it("backs up, configures, and restores official settings", async () => {
    mock.effective.set("chatgpt.cliExecutable", "/previous/codex");
    mock.global.set("chatgpt.cliExecutable", "/previous/codex");
    mock.effective.set("remote.extensionKind", { example: ["workspace"] });
    mock.global.set("remote.extensionKind", { example: ["workspace"] });
    const manager = new OfficialSettingsManager(context());

    await expect(manager.configure("/extension/shim.cjs")).resolves.toBe(true);
    expect(manager.status("/extension/shim.cjs").configured).toBe(true);
    expect(mock.effective.get("remote.extensionKind")).toEqual({
      example: ["workspace"],
      "openai.chatgpt": ["ui"],
    });
    await expect(manager.configure("/extension/shim.cjs")).resolves.toBe(false);
    await expect(manager.restore()).resolves.toBe(true);
    expect(mock.effective.get("chatgpt.cliExecutable")).toBe("/previous/codex");
    expect(mock.effective.get("remote.extensionKind")).toEqual({
      example: ["workspace"],
    });
    await expect(manager.restore()).resolves.toBe(false);
  });
});
