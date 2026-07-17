import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { repairCodexViewLocation } from "../src/extension/view-location.js";

function state() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (values.get(key) as T | undefined) ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  } as unknown as vscode.Memento;
}

describe("repairCodexViewLocation", () => {
  it("focuses, resets, and reopens the Codex view only once per workspace", async () => {
    const executeCommand = vi.fn(async (_command: string) => undefined);
    const commands = {
      getCommands: vi.fn(async () => [
        "chatgpt.sidebarSecondaryView.focus",
        "workbench.action.resetFocusedViewLocation",
      ]),
      executeCommand,
    } as unknown as typeof vscode.commands;
    const workspaceState = state();

    await expect(repairCodexViewLocation(commands, workspaceState)).resolves.toBe("repaired");
    expect(executeCommand.mock.calls.map(([command]) => command)).toEqual([
      "chatgpt.sidebarSecondaryView.focus",
      "workbench.action.resetFocusedViewLocation",
      "chatgpt.sidebarSecondaryView.focus",
    ]);
    await expect(repairCodexViewLocation(commands, workspaceState)).resolves.toBe(
      "already-repaired",
    );
    expect(executeCommand).toHaveBeenCalledTimes(3);
  });

  it("leaves layout untouched when VS Code does not expose the focused-view reset command", async () => {
    const executeCommand = vi.fn(async (_command: string) => undefined);
    const commands = {
      getCommands: vi.fn(async () => ["chatgpt.sidebarSecondaryView.focus"]),
      executeCommand,
    } as unknown as typeof vscode.commands;

    await expect(repairCodexViewLocation(commands, state())).resolves.toBe("unavailable");
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
