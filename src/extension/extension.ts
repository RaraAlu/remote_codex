import * as vscode from "vscode";
import { OFFICIAL_CODEX_EXTENSION_ID } from "../core/official-codex.js";
import { REMOTE_EXECUTOR_EXTENSION_ID } from "../core/vscode-transport.js";
import { BridgeController } from "./controller.js";
import { repairCodexViewLocation } from "./view-location.js";

let controller: BridgeController | undefined;

function relevantExtensionFingerprint(): string {
  return [OFFICIAL_CODEX_EXTENSION_ID, REMOTE_EXECUTOR_EXTENSION_ID]
    .map((id) => {
      const extension = vscode.extensions.getExtension(id);
      const version = extension?.packageJSON.version;
      return extension
        ? `${id}\0${extension.extensionPath}\0${typeof version === "string" ? version : "unknown"}`
        : `${id}\0missing`;
    })
    .join("\0");
}

export function activate(context: vscode.ExtensionContext): void {
  controller = new BridgeController(context);
  const activeController = controller;
  let extensionFingerprint = relevantExtensionFingerprint();
  context.subscriptions.push(
    controller,
    ...controller.registerCommands(),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void controller?.initialize();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexRemoteBridge")) {
        void controller?.initialize();
      }
    }),
    vscode.extensions.onDidChange(() => {
      const nextFingerprint = relevantExtensionFingerprint();
      if (nextFingerprint === extensionFingerprint) {
        return;
      }
      extensionFingerprint = nextFingerprint;
      void controller?.initialize();
    }),
  );
  void repairCodexViewLocation(vscode.commands, context.workspaceState)
    .then((result) => {
      activeController.logCodexContextDrop(`layout.integration result=${result}`);
    })
    .catch((error: unknown) => {
      activeController.logCodexContextDrop(
        `layout.integration result=failed error=${JSON.stringify(String(error))}`,
      );
    });
  void controller.initialize();
}

export async function deactivate(): Promise<void> {
  await controller?.shutdown();
  controller = undefined;
}
