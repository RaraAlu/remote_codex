import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_MCP_NAME,
  reconcileExternalCliLauncher,
  reconcileExternalMcp,
  removeExternalCliLauncher,
  removeExternalMcp,
  resolveExternalCliExecutable,
  shouldReconcileExternalCliIntegration,
  type RunCodexMcp,
} from "../src/extension/external-cli-integration.js";

const posixIt = it.skipIf(process.platform === "win32");

function fakeCodexMcp(initialCommand?: string): {
  run: RunCodexMcp;
  calls: ReturnType<typeof vi.fn>;
} {
  let command = initialCommand;
  const calls = vi.fn();
  const run: RunCodexMcp = async (executable, args) => {
    calls(executable, args);
    if (args[1] === "get") {
      if (!command) {
        throw new Error("not found");
      }
      return JSON.stringify({
        name: EXTERNAL_MCP_NAME,
        transport: {
          type: "stdio",
          command,
          args: ["external-mcp"],
        },
      });
    }
    if (args[1] === "remove") {
      command = undefined;
      return "";
    }
    if (args[1] === "add") {
      command = args[4];
      return "";
    }
    throw new Error(`Unexpected Codex MCP invocation: ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("persistent current Codex CLI integration", () => {
  it("reconciles automatically unless the user explicitly disables integration", () => {
    expect(shouldReconcileExternalCliIntegration(undefined)).toBe(true);
    expect(shouldReconcileExternalCliIntegration(true)).toBe(true);
    expect(shouldReconcileExternalCliIntegration(false)).toBe(false);
  });

  it("installs the Bridge MCP and leaves an identical registration untouched", async () => {
    const fake = fakeCodexMcp();
    await expect(
      reconcileExternalMcp("codex", "/bridge/current/shim", fake.run),
    ).resolves.toBe("installed");
    await expect(
      reconcileExternalMcp("codex", "/bridge/current/shim", fake.run),
    ).resolves.toBe("unchanged");
    expect(fake.calls.mock.calls).toContainEqual([
      "codex",
      [
        "mcp",
        "add",
        EXTERNAL_MCP_NAME,
        "--",
        "/bridge/current/shim",
        "external-mcp",
      ],
    ]);
  });

  it("refreshes a versioned Shim path and supports explicit removal", async () => {
    const fake = fakeCodexMcp("/bridge/old/shim");
    await expect(
      reconcileExternalMcp("codex", "/bridge/new/shim", fake.run),
    ).resolves.toBe("updated");
    await expect(removeExternalMcp("codex", fake.run)).resolves.toBe(true);
    await expect(removeExternalMcp("codex", fake.run)).resolves.toBe(false);
  });

  posixIt("installs and refreshes a managed stable POSIX launcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-launcher-"));
    const launcherPath = join(directory, "bin", "codex-vscode");
    const integrationPath = join(directory, "state", "integration.json");
    const firstShim = join(directory, "shim-0.3.0.cjs");
    const secondShim = join(directory, "shim-0.3.1.cjs");
    await writeFile(firstShim, "first");
    await writeFile(secondShim, "second");
    const options = {
      hostPlatform: "linux" as const,
      integrationPath,
      launcherPath,
    };

    await expect(
      reconcileExternalCliLauncher("codex", firstShim, options),
    ).resolves.toMatchObject({ launcherPath, result: "installed" });
    await expect(readlink(launcherPath)).resolves.toBe(firstShim);
    await expect(
      reconcileExternalCliLauncher("codex", firstShim, options),
    ).resolves.toMatchObject({ result: "unchanged" });
    await expect(
      reconcileExternalCliLauncher("codex", secondShim, options),
    ).resolves.toMatchObject({ result: "updated" });
    await expect(readlink(launcherPath)).resolves.toBe(secondShim);
    await expect(removeExternalCliLauncher(options)).resolves.toBe(true);
    await expect(stat(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers a Windows PATHEXT launcher over the extensionless POSIX shim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-windows-path-"));
    const extensionlessPath = join(directory, "codex");
    const commandPath = join(directory, "codex.cmd");
    await writeFile(extensionlessPath, "#!/bin/sh\n");
    await writeFile(commandPath, "@echo off\r\n");

    await expect(
      resolveExternalCliExecutable("codex", {
        environment: { PATH: directory, PATHEXT: ".CMD" },
        hostPlatform: "win32",
        integrationPath: join(directory, "integration.json"),
      }),
    ).resolves.toEqual({
      commandPath,
      executablePath: await realpath(commandPath),
    });
  });

  it("manages, refreshes, and restores the complete Windows npm launcher set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-windows-automatic-"));
    const binDirectory = join(directory, "npm");
    const integrationPath = join(directory, "state", "integration.json");
    const launcherPath = join(directory, "bridge", "codex-vscode.exe");
    const shimPath = join(directory, "shim.exe");
    const shellPath = join(binDirectory, "codex");
    const commandPath = join(binDirectory, "codex.cmd");
    const powershellPath = join(binDirectory, "codex.ps1");
    const original = {
      cmd: "@echo original cmd\r\n",
      powershell: "# original powershell\r\n",
      shell: "#!/bin/sh\n# original shell\n",
    };
    await mkdir(binDirectory, { recursive: true });
    await writeFile(shellPath, original.shell);
    await writeFile(commandPath, original.cmd);
    await writeFile(powershellPath, original.powershell);
    await writeFile(shimPath, "bridge-shim");
    const options = {
      environment: { PATH: binDirectory, PATHEXT: ".CMD" },
      hostPlatform: "win32" as const,
      integrationPath,
      launcherPath,
    };

    const resolved = await resolveExternalCliExecutable("codex", options);
    expect(resolved).toMatchObject({
      commandPath,
      executablePath: commandPath,
      windowsAutomaticLauncher: {
        commandPath,
        kind: "windows-npm",
      },
    });
    await expect(
      reconcileExternalCliLauncher(resolved.executablePath, shimPath, {
        ...options,
        windowsAutomaticLauncher: resolved.windowsAutomaticLauncher,
      }),
    ).resolves.toMatchObject({
      automaticLauncher: { launcherPath: commandPath, result: "installed" },
      launcherPath,
      result: "installed",
    });

    const backupShell = join(binDirectory, ".codex-remote-bridge-original");
    const backupCommand = join(binDirectory, ".codex-remote-bridge-original.cmd");
    const backupPowerShell = join(binDirectory, ".codex-remote-bridge-original.ps1");
    await expect(readFile(backupShell, "utf8")).resolves.toBe(original.shell);
    await expect(readFile(backupCommand, "utf8")).resolves.toBe(original.cmd);
    await expect(readFile(backupPowerShell, "utf8")).resolves.toBe(
      original.powershell,
    );
    await expect(
      readFile(integrationPath, "utf8").then((value) => JSON.parse(value)),
    ).resolves.toMatchObject({
      version: 3,
      codexExecutable: backupCommand,
      automaticLauncher: {
        commandPath,
        kind: "windows-npm",
      },
    });
    await expect(readFile(commandPath, "utf8")).resolves.toContain(
      "codex-vscode.exe\" automatic-cli %*",
    );
    await expect(readFile(powershellPath, "utf8")).resolves.toContain(
      "& $bridge 'automatic-cli' @args",
    );
    await expect(readFile(shellPath, "utf8")).resolves.toContain(
      "automatic-cli \"$@\"",
    );

    const managed = await resolveExternalCliExecutable("codex", options);
    expect(managed.executablePath).toBe(backupCommand);
    await expect(
      reconcileExternalCliLauncher(managed.executablePath, shimPath, {
        ...options,
        windowsAutomaticLauncher: managed.windowsAutomaticLauncher,
      }),
    ).resolves.toMatchObject({
      automaticLauncher: { result: "unchanged" },
      result: "unchanged",
    });

    const upgraded = {
      cmd: "@echo upgraded cmd\r\n",
      powershell: "# upgraded powershell\r\n",
      shell: "#!/bin/sh\n# upgraded shell\n",
    };
    await writeFile(shellPath, upgraded.shell);
    await writeFile(commandPath, upgraded.cmd);
    await writeFile(powershellPath, upgraded.powershell);
    const afterUpgrade = await resolveExternalCliExecutable("codex", options);
    expect(afterUpgrade.executablePath).toBe(commandPath);
    await expect(
      reconcileExternalCliLauncher(afterUpgrade.executablePath, shimPath, {
        ...options,
        windowsAutomaticLauncher: afterUpgrade.windowsAutomaticLauncher,
      }),
    ).resolves.toMatchObject({
      automaticLauncher: { result: "updated" },
      result: "updated",
    });
    await expect(readFile(backupCommand, "utf8")).resolves.toBe(upgraded.cmd);

    await expect(removeExternalCliLauncher(options)).resolves.toBe(true);
    await expect(readFile(shellPath, "utf8")).resolves.toBe(upgraded.shell);
    await expect(readFile(commandPath, "utf8")).resolves.toBe(upgraded.cmd);
    await expect(readFile(powershellPath, "utf8")).resolves.toBe(
      upgraded.powershell,
    );
    await expect(stat(backupShell)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(backupCommand)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(backupPowerShell)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a colliding Windows npm launcher backup before changing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-windows-collision-"));
    const binDirectory = join(directory, "npm");
    const integrationPath = join(directory, "state", "integration.json");
    const launcherPath = join(directory, "bridge", "codex-vscode.exe");
    const shimPath = join(directory, "shim.exe");
    const shellPath = join(binDirectory, "codex");
    const commandPath = join(binDirectory, "codex.cmd");
    const powershellPath = join(binDirectory, "codex.ps1");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(shellPath, "shell-original");
    await writeFile(commandPath, "cmd-original");
    await writeFile(powershellPath, "powershell-original");
    await writeFile(join(binDirectory, ".codex-remote-bridge-original.cmd"), "owned");
    await writeFile(shimPath, "bridge-shim");
    const options = {
      environment: { PATH: binDirectory, PATHEXT: ".CMD" },
      hostPlatform: "win32" as const,
      integrationPath,
      launcherPath,
    };
    const resolved = await resolveExternalCliExecutable("codex", options);

    await expect(
      reconcileExternalCliLauncher(resolved.executablePath, shimPath, {
        ...options,
        windowsAutomaticLauncher: resolved.windowsAutomaticLauncher,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(readFile(shellPath, "utf8")).resolves.toBe("shell-original");
    await expect(readFile(commandPath, "utf8")).resolves.toBe("cmd-original");
    await expect(readFile(powershellPath, "utf8")).resolves.toBe(
      "powershell-original",
    );
    await expect(stat(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(integrationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a Windows npm launcher that changed before disable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-windows-disable-"));
    const binDirectory = join(directory, "npm");
    const integrationPath = join(directory, "state", "integration.json");
    const launcherPath = join(directory, "bridge", "codex-vscode.exe");
    const shimPath = join(directory, "shim.exe");
    const shellPath = join(binDirectory, "codex");
    const commandPath = join(binDirectory, "codex.cmd");
    const powershellPath = join(binDirectory, "codex.ps1");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(shellPath, "shell-original");
    await writeFile(commandPath, "cmd-original");
    await writeFile(powershellPath, "powershell-original");
    await writeFile(shimPath, "bridge-shim");
    const options = {
      environment: { PATH: binDirectory, PATHEXT: ".CMD" },
      hostPlatform: "win32" as const,
      integrationPath,
      launcherPath,
    };
    const resolved = await resolveExternalCliExecutable("codex", options);
    await reconcileExternalCliLauncher(resolved.executablePath, shimPath, {
      ...options,
      windowsAutomaticLauncher: resolved.windowsAutomaticLauncher,
    });

    await writeFile(commandPath, "npm-upgraded-current");
    await expect(removeExternalCliLauncher(options)).resolves.toBe(true);
    await expect(readFile(commandPath, "utf8")).resolves.toBe(
      "npm-upgraded-current",
    );
    await expect(readFile(shellPath, "utf8")).resolves.toBe("shell-original");
    await expect(readFile(powershellPath, "utf8")).resolves.toBe(
      "powershell-original",
    );
    await expect(
      stat(join(binDirectory, ".codex-remote-bridge-original.cmd")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replace an unmanaged launcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-launcher-collision-"));
    const launcherPath = join(directory, "codex-vscode");
    const shimPath = join(directory, "shim.cjs");
    await writeFile(launcherPath, "user-owned");
    await writeFile(shimPath, "bridge");

    await expect(
      reconcileExternalCliLauncher("codex", shimPath, {
        hostPlatform: "linux",
        integrationPath: join(directory, "integration.json"),
        launcherPath,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(readFile(launcherPath, "utf8")).resolves.toBe("user-owned");
  });

  posixIt("takes over plain codex safely and restores its exact original symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-automatic-"));
    const binDirectory = join(directory, "bin");
    const libraryDirectory = join(directory, "lib");
    const automaticLauncherPath = join(binDirectory, "codex");
    const launcherPath = join(binDirectory, "codex-vscode");
    const integrationPath = join(directory, "state", "integration.json");
    const codexExecutable = join(libraryDirectory, "codex.js");
    const shimPath = join(directory, "shim.cjs");
    const upgradedShimPath = join(directory, "shim-upgraded.cjs");
    await mkdir(binDirectory, { recursive: true });
    await mkdir(libraryDirectory, { recursive: true });
    await writeFile(codexExecutable, "#!/usr/bin/env node\n");
    await chmod(codexExecutable, 0o755);
    await writeFile(shimPath, "#!/usr/bin/env node\n");
    await chmod(shimPath, 0o755);
    await writeFile(upgradedShimPath, "#!/usr/bin/env node\n");
    await chmod(upgradedShimPath, 0o755);
    await symlink("../lib/codex.js", automaticLauncherPath);
    const options = {
      automaticLauncherPath,
      environment: { PATH: binDirectory },
      hostPlatform: "linux" as const,
      integrationPath,
      launcherPath,
    };

    await expect(
      resolveExternalCliExecutable("codex", options),
    ).resolves.toEqual({
      automaticLauncherPath,
      commandPath: automaticLauncherPath,
      executablePath: codexExecutable,
    });
    await expect(
      reconcileExternalCliLauncher(codexExecutable, shimPath, options),
    ).resolves.toMatchObject({
      automaticLauncher: {
        launcherPath: automaticLauncherPath,
        result: "installed",
      },
    });
    await expect(readlink(automaticLauncherPath)).resolves.toBe(shimPath);
    await expect(
      resolveExternalCliExecutable("codex", options),
    ).resolves.toMatchObject({ executablePath: codexExecutable });
    await expect(
      reconcileExternalCliLauncher(codexExecutable, shimPath, options),
    ).resolves.toMatchObject({
      automaticLauncher: { result: "unchanged" },
    });
    await expect(
      reconcileExternalCliLauncher(codexExecutable, upgradedShimPath, options),
    ).resolves.toMatchObject({
      automaticLauncher: { result: "updated" },
      result: "updated",
    });
    await expect(readlink(automaticLauncherPath)).resolves.toBe(
      upgradedShimPath,
    );
    await expect(removeExternalCliLauncher(options)).resolves.toBe(true);
    await expect(readlink(automaticLauncherPath)).resolves.toBe("../lib/codex.js");
  });

  it("never replaces a regular-file plain codex launcher", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-cli-automatic-collision-"));
    const automaticLauncherPath = join(directory, "codex");
    const shimPath = join(directory, "shim.cjs");
    await writeFile(automaticLauncherPath, "user-owned");
    await writeFile(shimPath, "bridge");

    await expect(
      reconcileExternalCliLauncher(automaticLauncherPath, shimPath, {
        automaticLauncherPath,
        hostPlatform: "linux",
        integrationPath: join(directory, "integration.json"),
        launcherPath: join(directory, "codex-vscode"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(readFile(automaticLauncherPath, "utf8")).resolves.toBe(
      "user-owned",
    );
    await expect(stat(join(directory, "codex-vscode"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
