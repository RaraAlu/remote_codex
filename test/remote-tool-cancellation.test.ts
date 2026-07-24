import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { BridgeError } from "../src/core/errors.js";
import {
  RemoteToolCallCoordinator,
  ShimProxy,
  remoteToolIdempotencyKey,
  type RpcMessageWriter,
} from "../src/shim/proxy.js";
import type { RpcRequest } from "../src/shim/rpc.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function toolCall(): RpcRequest {
  return {
    id: "tool-request-1",
    method: "item/tool/call",
    params: {
      arguments: { argv: ["sleep", "30"] },
      callId: "call-1",
      threadId: "thread-1",
      tool: "remote_exec",
      turnId: "turn-1",
    },
  };
}

describe("remote tool cancellation", () => {
  it("derives a stable idempotency key from the complete tool identity", () => {
    const call = toolCall();
    expect(remoteToolIdempotencyKey(call)).toMatch(/^[a-f0-9]{64}$/);
    expect(remoteToolIdempotencyKey(call)).toBe(remoteToolIdempotencyKey(toolCall()));
    expect(
      remoteToolIdempotencyKey({
        ...call,
        params: { ...(call.params as Record<string, unknown>), turnId: "turn-2" },
      }),
    ).not.toBe(remoteToolIdempotencyKey(call));
  });

  it("cancels only calls bound to the interrupted thread and turn", async () => {
    const coordinator = new RemoteToolCallCoordinator();
    const observedSignals: AbortSignal[] = [];
    const running = coordinator.run(toolCall(), 0, async (signal) => {
      observedSignals.push(signal);
      return await new Promise((_, reject) => {
        const cancel = (): void =>
          reject(new BridgeError("CANCELLED", "Remote tool call was cancelled"));
        if (signal.aborted) {
          cancel();
        } else {
          signal.addEventListener("abort", cancel, { once: true });
        }
      });
    });
    await vi.waitFor(() => expect(observedSignals).toHaveLength(1));

    expect(coordinator.cancelTurn("thread-2", "turn-1")).toBe(0);
    expect(observedSignals[0]?.aborted).toBe(false);
    expect(coordinator.cancelTurn("thread-1", "turn-1")).toBe(1);
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("interrupts a pending approval without starting SSH and records the cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-tool-cancel-"));
    directories.push(directory);
    const auditPath = join(directory, "audit.jsonl");
    const forwarded: unknown[] = [];
    const clientMessages: unknown[] = [];
    const spawnSsh = vi.fn(() => {
      throw new Error("SSH must not start after cancellation");
    });
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/workspace",
      }),
      controlDir: directory,
      spawnSsh,
    });
    const writeServer: RpcMessageWriter = (message) => forwarded.push(message);
    const writeClient: RpcMessageWriter = (message) => clientMessages.push(message);

    const handling = proxy.handleServerMessage(toolCall(), writeServer, writeClient);
    await vi.waitFor(() =>
      expect(
        clientMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "method" in message &&
            message.method === "item/commandExecution/requestApproval",
        ),
      ).toBe(true),
    );
    const interrupt = {
      id: "interrupt-1",
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    };
    await proxy.handleClientMessage(interrupt, writeServer, writeClient);
    await handling;
    proxy.closeSession();

    expect(spawnSsh).not.toHaveBeenCalled();
    expect(forwarded).toContainEqual(interrupt);
    const toolResponse = forwarded.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "id" in message &&
        message.id === "tool-request-1",
    ) as {
      result: { contentItems: Array<{ text: string }> };
    };
    expect(JSON.parse(toolResponse.result.contentItems[0]?.text ?? "{}")).toMatchObject({
      error: { code: "CANCELLED" },
      ok: false,
    });
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"operation":"remote_tool.cancel"');
    expect(audit).toContain('"outcome":"cancelled"');
    expect(audit).toContain('"cancelledCalls":1');
  });
});
