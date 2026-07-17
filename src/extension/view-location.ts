import type * as vscode from "vscode";

const CODEX_VIEW_FOCUS_COMMAND = "chatgpt.sidebarSecondaryView.focus";
const RESET_FOCUSED_VIEW_COMMAND = "workbench.action.resetFocusedViewLocation";
const REPAIRED_KEY = "codexRemoteBridge.codexViewLocationRepaired.v1";

export type ViewLocationRepairResult = "already-repaired" | "repaired" | "unavailable";

export async function repairCodexViewLocation(
  commands: typeof vscode.commands,
  workspaceState: vscode.Memento,
): Promise<ViewLocationRepairResult> {
  if (workspaceState.get<boolean>(REPAIRED_KEY, false)) {
    return "already-repaired";
  }

  const available = new Set(await commands.getCommands(true));
  if (
    !available.has(CODEX_VIEW_FOCUS_COMMAND) ||
    !available.has(RESET_FOCUSED_VIEW_COMMAND)
  ) {
    return "unavailable";
  }

  await commands.executeCommand(CODEX_VIEW_FOCUS_COMMAND);
  await commands.executeCommand(RESET_FOCUSED_VIEW_COMMAND);
  await commands.executeCommand(CODEX_VIEW_FOCUS_COMMAND);
  await workspaceState.update(REPAIRED_KEY, true);
  return "repaired";
}
