import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
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

  it("installs and refreshes a managed stable POSIX launcher", async () => {
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

  it("takes over plain codex safely and restores its exact original symlink", async () => {
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
