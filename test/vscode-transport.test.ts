import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  REMOTE_EXECUTOR_CAPABILITIES,
  REMOTE_EXECUTOR_VERSION,
  isRemoteExecutorPing,
  isTransportRequest,
} from "../src/core/vscode-transport.js";

describe("VS Code remote transport protocol", () => {
  it("accepts a Remote SSH executor by capabilities rather than version values", () => {
    expect(
      isRemoteExecutorPing({
        capabilities: REMOTE_EXECUTOR_CAPABILITIES,
        executorVersion: REMOTE_EXECUTOR_VERSION,
        protocolVersion: 4,
        remoteName: "ssh-remote",
      }),
    ).toBe(true);
    expect(
      isRemoteExecutorPing({
        capabilities: REMOTE_EXECUTOR_CAPABILITIES,
        executorVersion: "99.0.0",
        protocolVersion: 999,
        remoteName: "ssh-remote",
      }),
    ).toBe(true);
    expect(
      isRemoteExecutorPing({
        capabilities: REMOTE_EXECUTOR_CAPABILITIES,
        remoteName: "ssh-remote",
      }),
    ).toBe(true);
    expect(
      isRemoteExecutorPing({
        capabilities: REMOTE_EXECUTOR_CAPABILITIES,
        executorVersion: REMOTE_EXECUTOR_VERSION,
        protocolVersion: 4,
        remoteName: "dev-container",
      }),
    ).toBe(false);
    expect(
      isRemoteExecutorPing({
        capabilities: REMOTE_EXECUTOR_CAPABILITIES.filter(
          (capability) => capability !== "stdioStart",
        ),
        executorVersion: REMOTE_EXECUTOR_VERSION,
        protocolVersion: 4,
        remoteName: "ssh-remote",
      }),
    ).toBe(false);
    expect(isRemoteExecutorPing(null)).toBe(false);
  });

  it("keeps diagnostic version metadata synchronized with the packaged executor", async () => {
    const packageJson = JSON.parse(
      await readFile("remote-executor/package.json", "utf8"),
    ) as { version: string };
    expect(REMOTE_EXECUTOR_VERSION).toBe(packageJson.version);
  });

  it("accepts authenticated result-status transport requests", () => {
    expect(
      isTransportRequest({
        hostId: "remote-host",
        id: "status-1",
        operation: "resultStatus",
        outputCommand: "codexRemoteBridge.transport.output",
        params: { idempotencyKey: "stable-key" },
        policy: {
          commandTimeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
        token: "token",
        workspaceRoot: "/workspace",
      }),
    ).toBe(true);
  });
});
