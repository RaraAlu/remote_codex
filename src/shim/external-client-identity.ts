import { randomUUID } from "node:crypto";

export const VSCODE_CONVERSATION_CLIENT_NAME_PREFIX =
  "codex_remote_bridge_external_client_";

export const VSCODE_CONVERSATION_CLIENT_TITLE =
  "Codex Remote Bridge External Client";

export const VSCODE_CONVERSATION_CLIENT_VERSION = "0.1.0";

const UUID_SUFFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createVsCodeConversationClientName(): string {
  return `${VSCODE_CONVERSATION_CLIENT_NAME_PREFIX}${randomUUID()}`;
}

export function isVsCodeConversationClientName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(VSCODE_CONVERSATION_CLIENT_NAME_PREFIX) &&
    UUID_SUFFIX.test(value.slice(VSCODE_CONVERSATION_CLIENT_NAME_PREFIX.length))
  );
}
