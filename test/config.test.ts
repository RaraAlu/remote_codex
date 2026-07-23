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
      sshExecutable: "ssh",
      remoteMcpRouting: "auto",
      remoteMcpAccess: "enabled",
      commandTimeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
      maxParallelReads: 8,
      maxParallelWrites: 1,
      connectTimeoutSeconds: 10,
    });
  });

  it("ignores the removed legacy Codex executable setting", () => {
    expect(
      parseBridgeConfig({
        ...minimalConfig,
        codexExecutable: "/usr/local/bin/codex",
      }),
    ).not.toHaveProperty("codexExecutable");
  });

  it("accepts explicit direct-host OpenSSH routing without reading the key", () => {
    expect(
      parseBridgeConfig({
        ...minimalConfig,
        sshUser: "root",
        sshPort: 42013,
        identityFile: "/home/user/.ssh/id_ed25519",
      }),
    ).toMatchObject({
      host: "training-gpu",
      sshUser: "root",
      sshPort: 42013,
      identityFile: "/home/user/.ssh/id_ed25519",
    });
  });

  it("accepts a window-scoped VS Code Remote transport descriptor", () => {
    expect(
      parseBridgeConfig({
        ...minimalConfig,
        connectionMode: "vscode-remote",
        remoteHelper: "vscode-extension",
        vscodeTransport: {
          endpoint: "\\\\.\\pipe\\codex-bridge",
          sessionId: "session-1",
          token: "0123456789abcdef0123456789abcdef",
        },
      }),
    ).toMatchObject({
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
      vscodeTransport: { sessionId: "session-1" },
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
    [{ ...minimalConfig, remoteMcpRouting: "remote" }, "remoteMcpRouting"],
    [{ ...minimalConfig, remoteMcpAccess: "unrestricted" }, "remoteMcpAccess"],
    [{ ...minimalConfig, sshUser: "-oProxyCommand" }, "sshUser"],
    [{ ...minimalConfig, sshPort: 0 }, "sshPort"],
    [{ ...minimalConfig, sshPort: 65_536 }, "sshPort"],
    [{ ...minimalConfig, identityFile: "id_rsa" }, "identityFile"],
    [{ ...minimalConfig, identityFile: "/home/user/../id_rsa" }, "identityFile"],
  ])("rejects unsafe configuration %#", (input, expectedText) => {
    expect(() => parseBridgeConfig(input)).toThrowError(BridgeError);
    expect(() => parseBridgeConfig(input)).toThrowError(expectedText);
  });
});
