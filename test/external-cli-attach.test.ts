import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeExternalCliDir } from "../src/core/locations.js";
import {
  prepareExternalCliAttach,
  resolveExternalCliAttachArgs,
  runExternalCliAttach,
  selectAutomaticExternalCliSession,
  type SpawnAttachedCodex,
} from "../src/shim/external-cli-attach.js";
import type { ExternalCliSessionDescriptor } from "../src/shim/shared-app-server.js";

const originalStateDirectory = process.env.CODEX_BRIDGE_STATE_DIR;

afterEach(() => {
  if (originalStateDirectory === undefined) {
    delete process.env.CODEX_BRIDGE_STATE_DIR;
  } else {
    process.env.CODEX_BRIDGE_STATE_DIR = originalStateDirectory;
  }
});

async function writeSession(
  directory: string,
  pid: number,
  startedAtMs: number,
): Promise<ExternalCliSessionDescriptor> {
  const tokenPath = join(directory, `${pid}.token`);
  const descriptor: ExternalCliSessionDescriptor = {
    version: 1,
    endpoint: `ws://127.0.0.1:${pid === process.pid ? 4567 : 4568}`,
    host: "g1_1",
    pid,
    startedAtMs,
    tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
    tokenPath,
    workspaceRoot: "/remote/workspace",
    threadId: `thread-${pid}`,
  };
  await writeFile(tokenPath, `private-token-${pid}`, { mode: 0o600 });
  await writeFile(
    join(directory, `${pid}.json`),
    `${JSON.stringify(descriptor)}\n`,
    { mode: 0o600 },
  );
  return descriptor;
}

async function prepareState(): Promise<{
  descriptor: ExternalCliSessionDescriptor;
  directory: string;
}> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codex-cli-attach-"));
  process.env.CODEX_BRIDGE_STATE_DIR = stateDirectory;
  const directory = bridgeExternalCliDir();
  await mkdir(directory, { recursive: true });
  return {
    descriptor: await writeSession(directory, process.pid, Date.now()),
    directory,
  };
}

describe("bidirectional external CLI attach", () => {
  it("prefers the active thread for the current workspace and avoids ambiguity", () => {
    const first = {
      version: 1 as const,
      endpoint: "ws://127.0.0.1:4567",
      host: "local",
      pid: 100,
      startedAtMs: 2,
      tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
      tokenPath: "/state/100.token",
      workspaceRoot: "/workspace/first",
      threadId: "thread-first",
    };
    const second = {
      ...first,
      pid: 101,
      startedAtMs: 1,
      tokenPath: "/state/101.token",
      workspaceRoot: "/workspace/second",
      threadId: "thread-second",
    };

    expect(
      selectAutomaticExternalCliSession([first, second], "/workspace/second"),
    ).toBe(second);
    expect(() =>
      selectAutomaticExternalCliSession([first, second], "/workspace/unknown"),
    ).toThrow(/codex-vscode --session-pid/);
    expect(
      selectAutomaticExternalCliSession([first], "/workspace/unknown"),
    ).toBe(first);
  });

  it("passes the capability token only through the remote Codex child environment", async () => {
    const { descriptor } = await prepareState();
    const prepared = await prepareExternalCliAttach({
      codexExecutable: "codex-test",
      sessionPid: descriptor.pid,
    });

    expect(prepared.command).toBe("codex-test");
    expect(prepared.args).toEqual([
      "resume",
      "--remote",
      descriptor.endpoint,
      "--remote-auth-token-env",
      descriptor.tokenEnv,
      descriptor.threadId,
    ]);
    expect(prepared.environment[descriptor.tokenEnv]).toBe(
      `private-token-${descriptor.pid}`,
    );
    expect(prepared.args.join(" ")).not.toContain("private-token");
  });

  it("fails closed on an ambiguous session and accepts an explicit session pid", async () => {
    const { descriptor, directory } = await prepareState();
    const second = await writeSession(directory, process.ppid, Date.now() + 1);

    await expect(
      prepareExternalCliAttach({ codexExecutable: "codex-test" }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    await expect(
      prepareExternalCliAttach({
        codexExecutable: "codex-test",
        sessionPid: descriptor.pid,
      }),
    ).resolves.toMatchObject({ threadId: descriptor.threadId });
    await expect(
      prepareExternalCliAttach({
        codexExecutable: "codex-test",
        sessionPid: second.pid,
      }),
    ).resolves.toMatchObject({ threadId: second.threadId });
  });

  it("feature-detects authenticated remote resume before launching the TUI", async () => {
    const { descriptor } = await prepareState();
    const child = new EventEmitter() as ChildProcess;
    const spawnCodex = vi.fn<SpawnAttachedCodex>(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await expect(
      runExternalCliAttach(
        {
          codexExecutable: "codex-test",
          sessionPid: descriptor.pid,
        },
        async () => "--remote <ADDR>\n--remote-auth-token-env <ENV_VAR>\n",
        spawnCodex,
        async () => true,
      ),
    ).resolves.toBe(0);
    expect(spawnCodex).toHaveBeenCalledOnce();
    expect(spawnCodex.mock.calls[0]?.[2].stdio).toBe("inherit");
  });

  it("starts a synchronized thread when the selected VS Code thread is not materialized", async () => {
    const { descriptor } = await prepareState();
    const prepared = await prepareExternalCliAttach({
      codexExecutable: "codex-test",
      sessionPid: descriptor.pid,
    });

    await expect(resolveExternalCliAttachArgs(prepared, async () => false)).resolves.toEqual([
      "--remote",
      descriptor.endpoint,
      "--remote-auth-token-env",
      descriptor.tokenEnv,
    ]);
  });
});
