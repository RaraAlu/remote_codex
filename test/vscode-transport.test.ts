import { describe, expect, it } from "vitest";
import { isRemoteExecutorPing } from "../src/core/vscode-transport.js";

describe("VS Code remote transport protocol", () => {
  it("accepts only the expected Remote SSH executor handshake", () => {
    expect(isRemoteExecutorPing({ protocolVersion: 4, remoteName: "ssh-remote" })).toBe(true);
    expect(isRemoteExecutorPing({ protocolVersion: 3, remoteName: "ssh-remote" })).toBe(false);
    expect(isRemoteExecutorPing({ protocolVersion: 4, remoteName: "dev-container" })).toBe(false);
    expect(isRemoteExecutorPing(null)).toBe(false);
  });
});
