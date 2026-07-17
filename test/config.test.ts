import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { BridgeError } from "../src/core/errors.js";

const minimalConfig = {
  host: "training-gpu",
  workspaceRoot: "/home/zkbot/work/train/MimicLite",
};

describe("parseBridgeConfig", () => {
  it("applies secure MVP defaults", () => {
    expect(parseBridgeConfig(minimalConfig)).toEqual({
      version: 1,
      host: "training-gpu",
      workspaceRoot: "/home/zkbot/work/train/MimicLite",
      connectionMode: "openssh",
      localExecution: "deny",
      remoteHelper: "none",
      codexExecutable: "codex",
      commandTimeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
      maxParallelReads: 8,
      maxParallelWrites: 1,
      connectTimeoutSeconds: 10,
    });
  });

  it.each([
    [{ ...minimalConfig, host: "-oProxyCommand=bad" }, "host"],
    [{ ...minimalConfig, host: "*.example.com" }, "host"],
    [{ ...minimalConfig, workspaceRoot: "relative/path" }, "workspaceRoot"],
    [{ ...minimalConfig, workspaceRoot: "/home/../tmp" }, "workspaceRoot"],
    [{ ...minimalConfig, workspaceRoot: "/" }, "workspaceRoot"],
    [{ ...minimalConfig, localExecution: "allow" }, "localExecution"],
    [{ ...minimalConfig, remoteHelper: "daemon" }, "remoteHelper"],
    [{ ...minimalConfig, maxParallelWrites: 2 }, "maxParallelWrites"],
  ])("rejects unsafe configuration %#", (input, expectedText) => {
    expect(() => parseBridgeConfig(input)).toThrowError(BridgeError);
    expect(() => parseBridgeConfig(input)).toThrowError(expectedText);
  });
});
