import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_OUTPUT_COMMAND,
  type RemoteExecutorCommandRequest,
  type RemoteExecutorCommandResponse,
} from "../src/core/vscode-transport.js";

const mock = vi.hoisted(() => ({
  commands: new Map<string, (request: RemoteExecutorCommandRequest) => unknown>(),
  workspaceRoot: "",
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(async () => undefined),
    registerCommand: (
      command: string,
      callback: (request: RemoteExecutorCommandRequest) => unknown,
    ) => {
      mock.commands.set(command, callback);
      return { dispose: () => mock.commands.delete(command) };
    },
  },
  env: {
    remoteName: "ssh-remote",
  },
  workspace: {
    get workspaceFolders() {
      return [{ uri: { path: mock.workspaceRoot, scheme: "vscode-remote" } }];
    },
  },
}));

import { activate, deactivate } from "../src/remote-extension/extension.js";

let workspace = "";

afterEach(async () => {
  deactivate();
  mock.commands.clear();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
  workspace = "";
  mock.workspaceRoot = "";
});

function request(
  id: string,
  operation: RemoteExecutorCommandRequest["operation"],
  params: Record<string, unknown>,
): RemoteExecutorCommandRequest {
  return {
    hostId: "remote-host",
    id,
    operation,
    outputCommand: REMOTE_OUTPUT_COMMAND,
    params,
    policy: {
      commandTimeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    },
    workspaceRoot: workspace,
  };
}

describe.skipIf(process.platform === "win32")("Remote Executor cancellation", () => {
  it("binds cancel to the active execute request and returns CANCELLED", async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), "codex-remote-cancel-")));
    mock.workspaceRoot = workspace;
    activate({ subscriptions: [] } as never);
    const execute = mock.commands.get(REMOTE_EXECUTOR_COMMAND);
    expect(execute).toBeTypeOf("function");

    const running = execute?.(
      request("operation-1", "execute", {
        argv: ["sleep", "30"],
        options: { sideEffect: true },
      }),
    ) as Promise<RemoteExecutorCommandResponse>;
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(
      execute?.(
        request("cancel-1", "cancel", {
          operationId: "operation-1",
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      result: {
        cancelled: true,
        operationId: "operation-1",
      },
    });
    await expect(running).resolves.toMatchObject({
      error: {
        code: "CANCELLED",
        details: { sideEffectMayHaveOccurred: true },
      },
      ok: false,
    });
  });
});
