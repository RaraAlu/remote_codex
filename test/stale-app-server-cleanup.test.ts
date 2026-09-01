import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleOfficialAppServers,
  type StaleAppServerCleanupOptions,
} from "../src/extension/stale-app-server-cleanup.js";
import type {
  ProcessIdentity,
  ProcessIdentityInspector,
} from "../src/shim/process-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-stale-app-server-"));
  temporaryDirectories.push(root);
  const directory = join(root, "external-cli");
  await mkdir(directory, { recursive: true });
  return directory;
}

function identity(
  pid: number,
  executablePath: string,
  startedAtMs: number,
): ProcessIdentity {
  return { executablePath, pid, startedAtMs };
}

async function writeDescriptor(
  directory: string,
  value: Record<string, unknown>,
): Promise<string> {
  const pid = Number(value.pid);
  const path = join(directory, `${pid}.json`);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await writeFile(join(directory, `${pid}.token`), "external", { mode: 0o600 });
  await writeFile(join(directory, `${pid}.upstream.token`), "upstream", {
    mode: 0o600,
  });
  return path;
}

function descriptor(
  shim: ProcessIdentity,
  appServer: ProcessIdentity,
): Record<string, unknown> {
  return {
    version: 3,
    appServer,
    endpoint: "ws://127.0.0.1:4567",
    executablePath: shim.executablePath,
    host: "local",
    pid: shim.pid,
    startedAtMs: shim.startedAtMs,
    tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
    tokenPath: `/state/external-cli/${shim.pid}.token`,
    workspaceRoot: "/workspace",
    threadId: "thread-current",
  };
}

function processTable(
  entries: readonly ProcessIdentity[],
): {
  inspectProcesses: ProcessIdentityInspector;
  table: Map<number, ProcessIdentity>;
} {
  const table = new Map(entries.map((entry) => [entry.pid, entry]));
  return {
    table,
    inspectProcesses: async (pids) =>
      new Map(
        pids
          .map((pid) => table.get(pid))
          .filter((entry): entry is ProcessIdentity => entry !== undefined)
          .map((entry) => [entry.pid, entry]),
      ),
  };
}

function options(
  directory: string,
  inspectProcesses: ProcessIdentityInspector,
  overrides: Partial<StaleAppServerCleanupOptions> = {},
): StaleAppServerCleanupOptions {
  return {
    directory,
    hostPlatform: "linux",
    inspectProcesses,
    wait: async () => undefined,
    ...overrides,
  };
}

describe("stale official Codex app-server cleanup", () => {
  it("leaves a descriptor owned by its live Shim untouched", async () => {
    const directory = await createDirectory();
    const shim = identity(4101, "/state/bin/codex-bridge-shim", 10_000);
    const appServer = identity(4102, "/extension/bin/codex", 10_100);
    const path = await writeDescriptor(directory, descriptor(shim, appServer));
    const { inspectProcesses } = processTable([shim, appServer]);
    const terminateProcess = vi.fn();

    await expect(
      cleanupStaleOfficialAppServers(
        options(directory, inspectProcesses, { terminateProcess }),
      ),
    ).resolves.toEqual({
      failedPids: [],
      inspectedCount: 1,
      removedCount: 0,
      staleCount: 0,
      terminatedPids: [],
    });
    expect(terminateProcess).not.toHaveBeenCalled();
    await expect(readFile(path, "utf8")).resolves.toContain("thread-current");
  });

  it("terminates the verified app-server of a dead Shim and removes its files", async () => {
    const directory = await createDirectory();
    const shim = identity(4201, "/state/bin/codex-bridge-shim", 20_000);
    const appServer = identity(4202, "/extension/bin/codex", 20_100);
    const path = await writeDescriptor(directory, descriptor(shim, appServer));
    const processes = processTable([appServer]);
    const terminateProcess = vi.fn((pid: number) => {
      processes.table.delete(pid);
    });

    await expect(
      cleanupStaleOfficialAppServers(
        options(directory, processes.inspectProcesses, { terminateProcess }),
      ),
    ).resolves.toEqual({
      failedPids: [],
      inspectedCount: 1,
      removedCount: 1,
      staleCount: 1,
      terminatedPids: [appServer.pid],
    });
    expect(terminateProcess).toHaveBeenCalledWith(appServer.pid, "SIGTERM");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, `${shim.pid}.token`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(directory, `${shim.pid}.upstream.token`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not signal a reused app-server PID with another identity", async () => {
    const directory = await createDirectory();
    const shim = identity(4301, "/state/bin/codex-bridge-shim", 30_000);
    const appServer = identity(4302, "/extension/bin/codex", 30_100);
    await writeDescriptor(directory, descriptor(shim, appServer));
    const reused = identity(appServer.pid, "/usr/bin/unrelated", 90_000);
    const { inspectProcesses } = processTable([reused]);
    const terminateProcess = vi.fn();

    await expect(
      cleanupStaleOfficialAppServers(
        options(directory, inspectProcesses, { terminateProcess }),
      ),
    ).resolves.toMatchObject({
      failedPids: [],
      removedCount: 1,
      staleCount: 1,
      terminatedPids: [],
    });
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it("fails closed when a live Shim cannot be identified", async () => {
    const directory = await createDirectory();
    const shim = identity(4351, "/state/bin/codex-bridge-shim", 35_000);
    const appServer = identity(4352, "/extension/bin/codex", 35_100);
    const path = await writeDescriptor(directory, descriptor(shim, appServer));
    const terminateProcess = vi.fn();

    await expect(
      cleanupStaleOfficialAppServers(
        options(directory, async () => new Map(), {
          isProcessAlive: (pid) => pid === shim.pid,
          terminateProcess,
        }),
      ),
    ).resolves.toMatchObject({
      removedCount: 0,
      staleCount: 0,
      terminatedPids: [],
    });
    expect(terminateProcess).not.toHaveBeenCalled();
    await expect(access(path)).resolves.toBeUndefined();
  });

  it("preserves a descriptor replaced while stale cleanup is inspecting it", async () => {
    const directory = await createDirectory();
    const shim = identity(4371, "/state/bin/codex-bridge-shim", 37_000);
    const appServer = identity(4372, "/extension/bin/codex", 37_100);
    const path = await writeDescriptor(directory, descriptor(shim, appServer));
    const replacement = {
      ...descriptor(
        identity(shim.pid, shim.executablePath, 38_000),
        identity(4373, appServer.executablePath, 38_100),
      ),
      threadId: "thread-replacement",
    };
    let replaced = false;
    const inspectProcesses: ProcessIdentityInspector = async () => {
      if (!replaced) {
        replaced = true;
        await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      }
      return new Map();
    };

    await expect(
      cleanupStaleOfficialAppServers(
        options(directory, inspectProcesses, { isProcessAlive: () => false }),
      ),
    ).resolves.toMatchObject({ removedCount: 0, staleCount: 1 });
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${JSON.stringify(replacement)}\n`,
    );
  });

  it("migrates a legacy v2 descriptor by matching its private upstream token", async () => {
    const directory = await createDirectory();
    const shim = identity(4401, "/state/bin/codex-bridge-shim", 40_000);
    const appServer = identity(4402, "/extension/bin/codex", 40_100);
    await writeDescriptor(directory, {
      ...descriptor(shim, appServer),
      version: 2,
      appServer: undefined,
    });
    const processes = processTable([appServer]);
    const terminateProcess = vi.fn((pid: number) => {
      processes.table.delete(pid);
    });
    const findLegacyAppServers = vi.fn(async () => [appServer]);

    await expect(
      cleanupStaleOfficialAppServers(
        options(directory, processes.inspectProcesses, {
          findLegacyAppServers,
          terminateProcess,
        }),
      ),
    ).resolves.toMatchObject({
      removedCount: 1,
      staleCount: 1,
      terminatedPids: [appServer.pid],
    });
    expect(findLegacyAppServers).toHaveBeenCalledWith(
      join(directory, `${shim.pid}.upstream.token`),
    );
  });

  it("does nothing outside Linux", async () => {
    const directory = await createDirectory();
    await expect(
      cleanupStaleOfficialAppServers({ directory, hostPlatform: "win32" }),
    ).resolves.toEqual({
      failedPids: [],
      inspectedCount: 0,
      removedCount: 0,
      staleCount: 0,
      terminatedPids: [],
    });
  });
});
