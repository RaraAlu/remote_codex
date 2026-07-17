import * as vscode from "vscode";
import { BridgeController } from "./controller.js";

let controller: BridgeController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new BridgeController(context);
  context.subscriptions.push(controller, ...controller.registerCommands());
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
