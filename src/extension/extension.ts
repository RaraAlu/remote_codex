import * as vscode from "vscode";
import { BridgeController } from "./controller.js";

let controller: BridgeController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new BridgeController(context);
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
      void controller?.initialize();
    }),
  );
  void controller.initialize();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
