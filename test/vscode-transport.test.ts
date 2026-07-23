import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  REMOTE_EXECUTOR_VERSION,
  isRemoteExecutorPing,
} from "../src/core/vscode-transport.js";

describe("VS Code remote transport protocol", () => {
  it("accepts only the expected Remote SSH executor version and protocol", () => {
    expect(
      isRemoteExecutorPing({
        executorVersion: REMOTE_EXECUTOR_VERSION,
        protocolVersion: 4,
        remoteName: "ssh-remote",
      }),
    ).toBe(true);
    expect(
      isRemoteExecutorPing({
        executorVersion: "0.2.6",
        protocolVersion: 4,
        remoteName: "ssh-remote",
      }),
    ).toBe(false);
    expect(
      isRemoteExecutorPing({
        executorVersion: REMOTE_EXECUTOR_VERSION,
        protocolVersion: 3,
        remoteName: "ssh-remote",
      }),
    ).toBe(false);
    expect(
      isRemoteExecutorPing({
        executorVersion: REMOTE_EXECUTOR_VERSION,
        protocolVersion: 4,
        remoteName: "dev-container",
      }),
    ).toBe(false);
    expect(isRemoteExecutorPing(null)).toBe(false);
  });

  it("keeps the expected version synchronized with the packaged executor", async () => {
    const packageJson = JSON.parse(
      await readFile("remote-executor/package.json", "utf8"),
    ) as { version: string };
    expect(REMOTE_EXECUTOR_VERSION).toBe(packageJson.version);
  });
});
