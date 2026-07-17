import * as vscode from "vscode";
import { BridgeError } from "../core/errors.js";

export interface RemoteWorkspaceContext {
  host: string;
  workspaceRoot: string;
  workspaceUri: vscode.Uri;
}

const SSH_AUTHORITY_PREFIX = "ssh-remote+";

export function detectRemoteWorkspace(
  remoteName = vscode.env.remoteName,
  folders = vscode.workspace.workspaceFolders,
): RemoteWorkspaceContext {
  if (remoteName !== "ssh-remote") {
    throw new BridgeError(
      "INVALID_CONFIG",
      "Current window is not connected through VS Code Remote SSH",
    );
  }
  if (!folders || folders.length !== 1) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "MVP requires exactly one remote workspace folder",
    );
  }
  const folder = folders[0];
  if (!folder || folder.uri.scheme !== "vscode-remote") {
    throw new BridgeError("INVALID_CONFIG", "Workspace folder is not a VS Code remote URI");
  }
  if (!folder.uri.authority.startsWith(SSH_AUTHORITY_PREFIX)) {
    throw new BridgeError("INVALID_CONFIG", "Remote URI does not identify an SSH host");
  }
  const encodedHost = folder.uri.authority.slice(SSH_AUTHORITY_PREFIX.length);
  const host = decodeURIComponent(encodedHost);
  if (!host) {
    throw new BridgeError("INVALID_CONFIG", "Unable to identify the Remote SSH host alias");
  }
  return {
    host,
    workspaceRoot: folder.uri.path,
    workspaceUri: folder.uri,
  };
}
