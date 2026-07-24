import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  type RemoteExecutorCommandRequest,
  type RemoteExecutorCommandResponse,
} from "../src/core/vscode-transport.js";

const mock = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: mock.executeCommand,
  },
}));

import { VsCodeTransportServer } from "../src/extension/vscode-transport-server.js";

let transport: VsCodeTransportServer | null = null;

afterEach(async () => {
  await transport?.close();
  transport = null;
  mock.executeCommand.mockReset();
});

describe("VS Code Controller cancellation transport", () => {
  it.each(["socket", "controller"] as const)(
    "cancels a remote execute operation when the %s closes",
    async (closingSide) => {
      const config = parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/workspace",
        connectionMode: "vscode-remote",
        remoteHelper: "vscode-extension",
      });
      transport = new VsCodeTransportServer(() => config);
      const descriptor = await transport.start();
      let finishExecute: ((response: RemoteExecutorCommandResponse) => void) | undefined;
      const requests: RemoteExecutorCommandRequest[] = [];
      mock.executeCommand.mockImplementation(
        async (command: string, request: RemoteExecutorCommandRequest) => {
          expect(command).toBe(REMOTE_EXECUTOR_COMMAND);
          requests.push(request);
          if (request.operation === "execute") {
            return await new Promise<RemoteExecutorCommandResponse>((resolve) => {
              finishExecute = resolve;
            });
          }
          expect(request).toMatchObject({
            operation: "cancel",
            params: { operationId: "execute-1" },
          });
          finishExecute?.({
            error: {
              code: "CANCELLED",
              message: "Remote command and its process tree were cancelled",
              retryable: false,
            },
            ok: false,
          });
          return {
            ok: true,
            result: { cancelled: true, operationId: "execute-1" },
          };
        },
      );

      const socket = createConnection(descriptor.endpoint);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `${JSON.stringify({
          hostId: config.host,
          id: "execute-1",
          operation: "execute",
          outputCommand: "untrusted",
          params: {
            argv: ["sleep", "30"],
            idempotencyKey: "cancel-key",
            options: { sideEffect: true },
          },
          policy: {
            commandTimeoutMs: config.commandTimeoutMs,
            maxOutputBytes: config.maxOutputBytes,
          },
          token: descriptor.token,
          workspaceRoot: config.workspaceRoot,
        })}\n`,
      );
      await vi.waitFor(() => expect(requests[0]?.operation).toBe("execute"));

      if (closingSide === "socket") {
        socket.destroy();
      } else {
        await transport?.close();
        transport = null;
      }

      await vi.waitFor(() =>
        expect(requests.map((request) => request.operation)).toEqual([
          "execute",
          "cancel",
        ]),
      );
      socket.destroy();
    },
  );
});
