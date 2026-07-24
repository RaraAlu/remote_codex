import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { SpawnProcess } from "../src/core/ssh-executor.js";
import { ShimProxy } from "../src/shim/proxy.js";

function mutationRequest(expectedHash: string) {
  return {
    id: "tool-request",
    method: "item/tool/call",
    params: {
      arguments: {
        contentBase64: Buffer.from("updated\n").toString("base64"),
        expectedHash,
        path: "note.txt",
      },
      callId: "mutation-item",
      threadId: "thread-1",
      tool: "workspace_write_file",
      turnId: "turn-1",
    },
  };
}

async function observeThread(
  proxy: ShimProxy,
  permissions: string,
): Promise<void> {
  await proxy.handleClientMessage(
    {
      id: 1,
      method: "thread/start",
      params: { permissions },
    },
    () => undefined,
    () => undefined,
  );
  await proxy.handleServerMessage(
    {
      id: 1,
      result: { thread: { id: "thread-1" } },
    },
    () => undefined,
    () => undefined,
  );
}

describe("workspace mutation approval", () => {
  it("requires approval for replacement and audits only mutation metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-mutation-approval-"));
    const auditPath = join(directory, "audit.jsonl");
    const contentHash = createHash("sha256").update("updated\n").digest("hex");
    let spawns = 0;
    const spawnSsh: SpawnProcess = () => {
      spawns += 1;
      const source = `
        process.stdin.resume();
        process.stdin.on("end", () => {
          const zero = String.fromCharCode(0);
          process.stdout.write(
            "/remote/workspace" + zero +
            "/remote/workspace/note.txt" + zero +
            "8" + zero +
            "81a4" + zero +
            "1721779200" + zero +
            ${JSON.stringify(contentHash)}
          );
        });
      `;
      return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
    };
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      spawnSsh,
    });
    const clientMessages: Array<Record<string, unknown>> = [];
    const serverMessages: Array<Record<string, unknown>> = [];
    try {
      await observeThread(proxy, "workspace-write");
      const running = proxy.handleServerMessage(
        mutationRequest("a".repeat(64)),
        (message) => serverMessages.push(message as Record<string, unknown>),
        (message) => clientMessages.push(message as Record<string, unknown>),
      );
      await expect
        .poll(() => clientMessages.length)
        .toBe(1);
      expect(clientMessages[0]).toMatchObject({
        method: "item/commandExecution/requestApproval",
        params: {
          command:
            "workspace_write_file remote:remote-primary /remote/workspace/note.txt",
          cwd: "/remote/workspace",
        },
      });
      expect(JSON.stringify(clientMessages[0])).not.toContain("dXBkYXRlZAo=");

      await proxy.handleClientMessage(
        {
          id: clientMessages[0]?.id as string,
          result: { decision: "accept" },
        },
        () => undefined,
        () => undefined,
      );
      await running;
      expect(spawns).toBe(1);
      expect(serverMessages).toHaveLength(1);
      expect(serverMessages[0]).toMatchObject({
        id: "tool-request",
        result: { success: true },
      });

      const audit = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "workspace_mutation.approval",
            outcome: "succeeded",
            rootId: "remote-primary",
            target: "remote",
            details: expect.objectContaining({
              automatic: false,
              decision: "accept",
              path: "/remote/workspace/note.txt",
              tool: "workspace_write_file",
            }),
          }),
          expect.objectContaining({
            operation: "workspace_write_file",
            outcome: "succeeded",
            details: expect.objectContaining({
              bytesWritten: 8,
              newHash: contentHash,
              path: "note.txt",
            }),
          }),
        ]),
      );
      expect(await readFile(auditPath, "utf8")).not.toContain("dXBkYXRlZAo=");
    } finally {
      proxy.closeSession();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("auto-approves replacement only in full access mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-mutation-full-"));
    const auditPath = join(directory, "audit.jsonl");
    let spawns = 0;
    const spawnSsh: SpawnProcess = () => {
      spawns += 1;
      const source = `
        const zero = String.fromCharCode(0);
        process.stdin.resume();
        process.stdin.on("end", () => process.stdout.write(
          "/remote/workspace" + zero +
          "/remote/workspace/note.txt" + zero +
          "8" + zero +
          "81a4" + zero +
          "1721779200" + zero +
          "${"b".repeat(64)}"
        ));
      `;
      return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
    };
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "remote-host",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      spawnSsh,
    });
    const clientMessages: unknown[] = [];
    const serverMessages: unknown[] = [];
    try {
      await observeThread(proxy, "full-access");
      await proxy.handleServerMessage(
        mutationRequest("a".repeat(64)),
        (message) => serverMessages.push(message),
        (message) => clientMessages.push(message),
      );
      expect(clientMessages).toEqual([]);
      expect(spawns).toBe(1);
      expect(serverMessages).toHaveLength(1);
      const audit = await readFile(auditPath, "utf8");
      expect(audit).toContain('"permissionMode":"full-access"');
      expect(audit).toContain('"operation":"workspace_mutation.approval"');
    } finally {
      proxy.closeSession();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
