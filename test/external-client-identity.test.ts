import { describe, expect, it } from "vitest";
import {
  createVsCodeConversationClientName,
  isVsCodeConversationClientName,
} from "../src/shim/external-client-identity.js";

describe("external conversation client identity", () => {
  it("creates a distinct recognized identity for every gateway connection", () => {
    const first = createVsCodeConversationClientName();
    const second = createVsCodeConversationClientName();

    expect(first).not.toBe(second);
    expect(isVsCodeConversationClientName(first)).toBe(true);
    expect(isVsCodeConversationClientName(second)).toBe(true);
    expect(isVsCodeConversationClientName("codex_remote_bridge_external_client")).toBe(false);
    expect(isVsCodeConversationClientName("codex_vscode_bridge_mcp")).toBe(false);
  });
});
