import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeExternalCliDir } from "../src/core/locations.js";
import { discoverExternalCliSessions } from "../src/shim/external-session-registry.js";
import type { ExternalCliSessionDescriptor } from "../src/shim/shared-app-server.js";

const originalStateDirectory = process.env.CODEX_BRIDGE_STATE_DIR;

afterEach(() => {
  if (originalStateDirectory === undefined) {
    delete process.env.CODEX_BRIDGE_STATE_DIR;
  } else {
    process.env.CODEX_BRIDGE_STATE_DIR = originalStateDirectory;
  }
});

function descriptor(
  tokenPath: string,
  overrides: Partial<ExternalCliSessionDescriptor> = {},
): ExternalCliSessionDescriptor {
  return {
    version: 1,
    endpoint: "ws://127.0.0.1:4567",
    host: "g1_1",
    pid: process.pid,
    startedAtMs: 123,
    tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
    tokenPath,
    workspaceRoot: "/remote/workspace",
    threadId: "thread-current",
    ...overrides,
  };
}

describe("external Bridge session registry", () => {
  it("discovers only live, loopback-only session descriptors", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codex-external-session-"));
    process.env.CODEX_BRIDGE_STATE_DIR = stateDirectory;
    const directory = bridgeExternalCliDir();
    await mkdir(directory, { recursive: true });
    const tokenPath = join(directory, `${process.pid}.token`);
    await writeFile(tokenPath, "private-session-token", { mode: 0o600 });
    await writeFile(
      join(directory, `${process.pid}.json`),
      `${JSON.stringify(descriptor(tokenPath))}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "999999.json"),
      `${JSON.stringify(descriptor(tokenPath, { pid: 999999 }))}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, `${process.ppid}.json`),
      `${JSON.stringify(
        descriptor(tokenPath, {
          endpoint: "ws://0.0.0.0:4567",
          pid: process.ppid,
        }),
      )}\n`,
      { mode: 0o600 },
    );

    await expect(discoverExternalCliSessions()).resolves.toEqual([
      descriptor(tokenPath),
    ]);
  });
});
