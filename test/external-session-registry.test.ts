import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessIdentityInspector } from "../src/shim/process-identity.js";
import { discoverExternalCliSessions } from "../src/shim/external-session-registry.js";
import type { ExternalCliSessionDescriptor } from "../src/shim/shared-app-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

async function createRegistry(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-external-session-"));
  temporaryDirectories.push(root);
  const directory = join(root, "external-cli");
  await mkdir(directory, { recursive: true });
  return directory;
}

function descriptor(
  directory: string,
  overrides: Partial<ExternalCliSessionDescriptor> = {},
): ExternalCliSessionDescriptor {
  const pid = overrides.pid ?? process.pid;
  return {
    version: 2,
    endpoint: "ws://127.0.0.1:4567",
    executablePath: "C:\\bridge\\codex-bridge-shim.exe",
    host: "g1_1",
    pid,
    startedAtMs: 1_000,
    tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
    tokenPath: join(directory, `${pid}.token`),
    workspaceRoot: "/remote/workspace",
    threadId: "thread-current",
    ...overrides,
  };
}

async function writeDescriptor(
  directory: string,
  value: ExternalCliSessionDescriptor,
): Promise<string> {
  const path = join(directory, `${value.pid}.json`);
  await writeFile(value.tokenPath, "private-session-token", { mode: 0o600 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}

function inspector(
  entries: ReadonlyArray<{
    executablePath: string;
    pid: number;
    startedAtMs: number;
  }>,
): ProcessIdentityInspector {
  return async () => new Map(entries.map((entry) => [entry.pid, entry]));
}

describe("external Bridge session registry", () => {
  it("discovers a descriptor whose process identity matches", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory);
    await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(
        directory,
        inspector([
          {
            executablePath: "c:\\BRIDGE\\codex-bridge-shim.exe",
            pid: value.pid,
            startedAtMs: 1_750,
          },
        ]),
        "win32",
      ),
    ).resolves.toEqual([value]);
  });

  it("removes a descriptor when the PID belongs to a different process", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { pid: 42_424 });
    const descriptorPath = await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(
        directory,
        inspector([
          {
            executablePath: value.executablePath!,
            pid: value.pid,
            startedAtMs: 40_000,
          },
        ]),
        "win32",
      ),
    ).resolves.toEqual([]);
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(value.tokenPath, "utf8")).resolves.toBe(
      "private-session-token",
    );
  });

  it("rejects a matching start time owned by another executable", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { pid: 42_425 });
    const descriptorPath = await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(
        directory,
        inspector([
          {
            executablePath: "C:\\Windows\\System32\\notepad.exe",
            pid: value.pid,
            startedAtMs: value.startedAtMs,
          },
        ]),
        "win32",
      ),
    ).resolves.toEqual([]);
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a descriptor after its process exits", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { pid: 2_147_483_647 });
    const descriptorPath = await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(directory, inspector([]), "win32"),
    ).resolves.toEqual([]);
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps but omits a live descriptor when process inspection has no identity", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { pid: process.pid });
    const descriptorPath = await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(directory, inspector([]), "win32"),
    ).resolves.toEqual([]);
    await expect(access(descriptorPath)).resolves.toBeUndefined();
  });

  it("falls back to liveness when process inspection is unavailable", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { pid: process.pid });
    await writeDescriptor(directory, value);
    const unavailable: ProcessIdentityInspector = async () => {
      throw new Error("process inspection unavailable");
    };

    await expect(
      discoverExternalCliSessions(directory, unavailable, "win32"),
    ).resolves.toEqual([value]);
  });

  it("does not delete a descriptor replaced during process inspection", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { pid: 42_426 });
    const replacement = descriptor(directory, {
      pid: value.pid,
      startedAtMs: 90_000,
      threadId: "thread-replacement",
    });
    const descriptorPath = await writeDescriptor(directory, value);
    const replacingInspector: ProcessIdentityInspector = async () => {
      await writeFile(descriptorPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      return new Map([
        [
          value.pid,
          {
            executablePath: value.executablePath!,
            pid: value.pid,
            startedAtMs: 40_000,
          },
        ],
      ]);
    };

    await expect(
      discoverExternalCliSessions(directory, replacingInspector, "win32"),
    ).resolves.toEqual([]);
    await expect(readFile(descriptorPath, "utf8")).resolves.toBe(
      `${JSON.stringify(replacement)}\n`,
    );
  });

  it("accepts legacy descriptors for a recently started Shim process", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, {
      version: 1,
      executablePath: undefined,
      startedAtMs: 10_000,
    });
    await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(
        directory,
        inspector([
          {
            executablePath: "C:\\bridge\\codex-bridge-shim.exe",
            pid: value.pid,
            startedAtMs: 1_000,
          },
        ]),
        "win32",
      ),
    ).resolves.toEqual([value]);
  });

  it("rejects a legacy descriptor when the PID was reused by a newer Node process", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, {
      version: 1,
      executablePath: undefined,
      startedAtMs: 10_000,
    });
    const descriptorPath = await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(
        directory,
        inspector([
          {
            executablePath: "C:\\Program Files\\nodejs\\node.exe",
            pid: value.pid,
            startedAtMs: 11_000,
          },
        ]),
        "win32",
      ),
    ).resolves.toEqual([]);
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores descriptors that expose a non-loopback endpoint", async () => {
    const directory = await createRegistry();
    const value = descriptor(directory, { endpoint: "ws://0.0.0.0:4567" });
    await writeDescriptor(directory, value);

    await expect(
      discoverExternalCliSessions(directory, inspector([]), "win32"),
    ).resolves.toEqual([]);
  });
});
