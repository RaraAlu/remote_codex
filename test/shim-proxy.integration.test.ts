import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { SpawnProcess } from "../src/core/ssh-executor.js";
import {
  BLOCKED_LOCAL_CLIENT_METHODS,
  REMOTE_PERMISSION_PROFILE_ID,
} from "../src/shim/local-core-policy.js";
import { ShimProxy } from "../src/shim/proxy.js";
import { isRecord, type RpcMessage } from "../src/shim/rpc.js";
import { createToolRouteInventory } from "../src/shim/tool-routing.js";

function fakeAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    let pendingApprovalClientId = null;
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "bridge/testLocalApproval") {
        pendingApprovalClientId = message.id;
        process.stdout.write(JSON.stringify({
          id: "local-core-approval",
          method: "item/commandExecution/requestApproval",
          params: { command: "cat /tmp/local-project-decoy" },
        }) + "\\n");
        return;
      }
      if (message.id === "local-core-approval") {
        process.stdout.write(JSON.stringify({
          id: pendingApprovalClientId,
          result: { receivedApprovalResponse: message },
        }) + "\\n");
        return;
      }
      if (message.id !== undefined) {
        process.stdout.write(JSON.stringify({ id: message.id, result: { received: message } }) + "\\n");
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

function fakeRemoteExecAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    const call = {
      callId: "remote-item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tool: "remote_exec",
      arguments: { argv: ["printf", "hello"], cwd: "src" },
    };
    const emitCall = () => {
      process.stdout.write(JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: call.callId,
            type: "dynamicToolCall",
            tool: call.tool,
            arguments: call.arguments,
            status: "inProgress",
            success: null,
          },
        },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        id: "remote-tool-request-1",
        method: "item/tool/call",
        params: call,
      }) + "\\n");
    };
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "bridge/testRemoteExec") {
        emitCall();
        return;
      }
      if (message.method === "thread/start") {
        process.stdout.write(JSON.stringify({
          id: message.id,
          result: { thread: { id: call.threadId } },
        }) + "\\n");
        emitCall();
        return;
      }
      if (message.id === "remote-tool-request-1") {
        const result = message.result;
        process.stdout.write(JSON.stringify({
          method: "item/completed",
          params: {
            item: {
              id: call.callId,
              type: "dynamicToolCall",
              tool: call.tool,
              arguments: call.arguments,
              status: result?.success ? "completed" : "failed",
              success: result?.success === true,
              contentItems: result?.contentItems ?? [],
            },
          },
        }) + "\\n");
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

async function exerciseRemoteExecApproval(
  decision: "accept" | "decline" | null,
  fullAccess = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-approval-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  let sshSpawns = 0;
  let finishCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    finishCompleted = resolve;
  });
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        continue;
      }
      messages.push(parsed);
      if (
        parsed.method === "item/commandExecution/requestApproval" &&
        (typeof parsed.id === "string" || typeof parsed.id === "number")
      ) {
        input.write(
          `${JSON.stringify({
            id: parsed.id,
            result: { decision: decision ?? "decline" },
          })}\n`,
        );
      }
      if (parsed.method === "item/completed") {
        finishCompleted?.();
      }
    }
  });

  const spawnSsh: SpawnProcess = () => {
    sshSpawns += 1;
    return spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('/remote/workspace/src\\0hello\\n'); process.stderr.write('notice\\n');",
      ],
      { stdio: "pipe" },
    );
  };
  const proxy = new ShimProxy({
    appServerArgs: ["app-server", "--stdio"],
    auditPath: join(directory, "audit.jsonl"),
    codexExecutable: "fake-codex",
    config: parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
    }),
    controlDir: join(directory, "control"),
    input,
    output,
    errorOutput: new PassThrough(),
    spawnCodex: () => fakeRemoteExecAppServer(),
    spawnSsh,
  });
  const running = proxy.run();
  input.write(
    `${JSON.stringify(
      fullAccess
        ? {
            id: 1,
            method: "thread/start",
            params: { permissions: "full-access" },
          }
        : { id: 1, method: "bridge/testRemoteExec" },
    )}\n`,
  );
  await completed;
  input.end();
  await expect(running).resolves.toBe(0);
  return { messages, sshSpawns };
}

describe("ShimProxy JSONL integration", () => {
  it("identifies remote-routed MCP tools in the forwarded thread policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-remote-mcp-policy-"));
    const forwarded: RpcMessage[] = [];
    const proxyConfig = parseBridgeConfig({
      host: "training-gpu",
      workspaceRoot: "/remote/workspace",
    });
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: proxyConfig,
      controlDir: join(directory, "control"),
      toolRouteInventory: createToolRouteInventory(
        proxyConfig,
        { remoteMcpServers: ["codegraph"] },
      ),
    });

    await proxy.handleClientMessage(
      {
        id: 1,
        method: "thread/start",
        params: {},
      },
      (message) => forwarded.push(message as RpcMessage),
      () => undefined,
    );
    proxy.closeSession();

    expect(forwarded).toHaveLength(1);
    const message = forwarded[0] as { params: Record<string, unknown> };
    expect(String(message.params.developerInstructions)).toContain(
      "mcp:codegraph/*: provider=mcp; location=remote",
    );
    expect(String(message.params.developerInstructions)).toContain(
      "Never infer a tool's execution location from the presence or absence of target or rootId",
    );
  });

  it("scopes only the VS Code local task list to the open workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-local-thread-list-"));
    const vscodeMessages: Array<Record<string, unknown>> = [];
    const externalMessages: Array<Record<string, unknown>> = [];
    const common = {
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: null,
      controlDir: join(directory, "control"),
      rewriteClientMessages: false,
    };
    const vscodeProxy = new ShimProxy({
      ...common,
      clientIdentity: { clientId: "stdio", clientSource: "vscode" },
      threadListCwdProvider: async () => "/home/zkbot/work/train/MimicLite",
    });
    const externalProxy = new ShimProxy({
      ...common,
      clientIdentity: { clientId: "external", clientSource: "external-cli" },
    });

    const request = {
      id: 1,
      method: "thread/list",
      params: { cwd: null, limit: 50 },
    } as const;
    await vscodeProxy.handleClientMessage(
      request,
      (message) => vscodeMessages.push(message as Record<string, unknown>),
      () => undefined,
    );
    await externalProxy.handleClientMessage(
      request,
      (message) => externalMessages.push(message as Record<string, unknown>),
      () => undefined,
    );

    expect(vscodeMessages[0]).toMatchObject({
      params: { cwd: "/home/zkbot/work/train/MimicLite", limit: 50 },
    });
    expect(externalMessages[0]).toEqual(request);
  });

  it("scopes a Remote SSH task list to its workspace-specific control directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-remote-thread-list-"));
    const messages: Array<Record<string, unknown>> = [];
    const controlDir = join(directory, "remote-control", "workspace-id");
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      clientIdentity: { clientId: "stdio", clientSource: "vscode" },
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/home/unitree/mimiclite-sim2real",
      }),
      controlDir,
      rewriteClientMessages: true,
      threadListCwd: controlDir,
    });

    await proxy.handleClientMessage(
      {
        id: 1,
        method: "thread/list",
        params: { cwd: null, limit: 50 },
      },
      (message) => messages.push(message as Record<string, unknown>),
      () => undefined,
    );

    expect(messages[0]).toMatchObject({
      params: { cwd: controlDir, limit: 50 },
    });
  });

  it("auto-accepts local Core approval requests under maximum local access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-local-approval-"));
    const auditPath = join(directory, "audit.jsonl");
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    let buffer = "";
    let finishResponse: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        messages.push(message);
        if (message.id === 7) {
          finishResponse?.();
        }
      }
    });

    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "training-gpu",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput: new PassThrough(),
      spawnCodex: () => fakeAppServer(),
    });
    const running = proxy.run();
    input.write(
      `${JSON.stringify({
        id: 7,
        method: "bridge/testLocalApproval",
        params: {},
      })}\n`,
    );
    await response;
    input.end();
    await expect(running).resolves.toBe(0);

    expect(
      messages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    expect(messages).toContainEqual({
      id: 7,
      result: {
        receivedApprovalResponse: {
          id: "local-core-approval",
          result: { decision: "accept" },
        },
      },
    });
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"operation":"local_core_approval.auto_accepted"');
    expect(audit).not.toContain("/tmp/local-project-decoy");
  });

  it("auto-accepts every Core approval method without a client prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-auto-approval-"));
    const auditPath = join(directory, "audit.jsonl");
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "training-gpu",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
    });
    const serverMessages: Array<Record<string, unknown>> = [];
    const clientMessages: Array<Record<string, unknown>> = [];
    const methods = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
    ];

    for (const [index, method] of methods.entries()) {
      await proxy.handleServerMessage(
        {
          id: `approval-${index}`,
          method,
          params: {
            ...(index === 0
              ? { availableDecisions: ["accept", "acceptForSession", "decline"] }
              : {}),
            path: "/sensitive/path-not-for-audit",
          },
        },
        (message) => serverMessages.push(message as Record<string, unknown>),
        (message) => clientMessages.push(message as Record<string, unknown>),
      );
    }

    expect(clientMessages).toEqual([]);
    expect(serverMessages).toEqual([
      { id: "approval-0", result: { decision: "acceptForSession" } },
      { id: "approval-1", result: { decision: "accept" } },
      { id: "approval-2", result: { decision: "accept" } },
      { id: "approval-3", result: { decision: "approved_for_session" } },
      { id: "approval-4", result: { decision: "approved_for_session" } },
    ]);
    const audit = await readFile(auditPath, "utf8");
    expect(audit.match(/local_core_approval\.auto_accepted/g)).toHaveLength(5);
    expect(audit).not.toContain("/sensitive/path-not-for-audit");
  });

  it("forwards reviewed local Core requests under maximum local access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-local-core-"));
    const auditPath = join(directory, "audit.jsonl");
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      captured += chunk;
    });

    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "training-gpu",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput: new PassThrough(),
      spawnCodex: () => fakeAppServer(),
    });
    const running = proxy.run();
    const blockedMethods = [
      ...BLOCKED_LOCAL_CLIENT_METHODS,
      "fs/futureMutation",
      "process/futureControl",
    ];
    blockedMethods.forEach((method, index) => {
      input.write(
        `${JSON.stringify({
          id: index + 100,
          method,
          params: { path: "/tmp/local-project-decoy" },
        })}\n`,
      );
    });
    input.write(
      `${JSON.stringify({
        id: 999,
        method: "initialize",
        params: { capabilities: {} },
      })}\n`,
    );
    input.end();
    await expect(running).resolves.toBe(0);

    const messages = captured
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const forwarded = messages.filter((message) => isRecord(message.result));
    expect(forwarded).toHaveLength(blockedMethods.length + 1);
    expect(forwarded.at(-1)).toMatchObject({
      id: 999,
      result: {
        received: {
          id: 999,
          method: "initialize",
        },
      },
    });

    await expect(readFile(auditPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forwards managed pasted-text requests from the VS Code client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-local-attachment-"));
    const attachmentRoot = join(directory, ".codex", "attachments");
    const attachmentId = "123e4567-e89b-42d3-a456-426614174000";
    const pastedText = join(attachmentRoot, attachmentId, "pasted-text.txt");
    const auditPath = join(directory, "audit.jsonl");
    const serverMessages: Array<Record<string, unknown>> = [];
    const clientMessages: Array<Record<string, unknown>> = [];
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      localAttachmentRoot: attachmentRoot,
    });
    const request = {
      id: "paste-1",
      method: "fs/writeFile",
      params: {
        dataBase64: "c2Vuc2l0aXZlIHBhc3RlZA==",
        path: pastedText,
      },
    };

    await proxy.handleClientMessage(
      request,
      (message) => serverMessages.push(message as Record<string, unknown>),
      (message) => clientMessages.push(message as Record<string, unknown>),
    );

    expect(serverMessages).toEqual([request]);
    expect(clientMessages).toEqual([]);
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"operation":"local_attachment_request.forwarded"');
    expect(audit).toContain('"kind":"pasted-text"');
    expect(audit).not.toContain(pastedText);
    expect(audit).not.toContain("c2Vuc2l0aXZlIHBhc3RlZA==");
  });

  it("forwards managed attachment writes for non-VS Code clients under full access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-external-attachment-"));
    const attachmentRoot = join(directory, ".codex", "attachments");
    const clientMessages: Array<Record<string, unknown>> = [];
    const serverMessages: Array<Record<string, unknown>> = [];
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      clientIdentity: { clientId: "external", clientSource: "external-mcp" },
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      localAttachmentRoot: attachmentRoot,
    });

    await proxy.handleClientMessage(
      {
        id: "paste-2",
        method: "fs/writeFile",
        params: {
          dataBase64: "dGVzdA==",
          path: join(
            attachmentRoot,
            "123e4567-e89b-42d3-a456-426614174000",
            "pasted-text.txt",
          ),
        },
      },
      (message) => serverMessages.push(message as Record<string, unknown>),
      (message) => clientMessages.push(message as Record<string, unknown>),
    );

    expect(serverMessages).toHaveLength(1);
    expect(serverMessages[0]).toMatchObject({ id: "paste-2", method: "fs/writeFile" });
    expect(clientMessages).toEqual([]);
  });

  it("rewrites initialize and thread placement before forwarding to app-server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-proxy-"));
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      captured += chunk;
    });

    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: null,
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput: new PassThrough(),
      spawnCodex: () => fakeAppServer(),
    });
    const running = proxy.run();
    input.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "test", title: "Test", version: "1" } },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: "/local/project", sandbox: "danger-full-access" },
      })}\n`,
    );
    input.end();
    await expect(running).resolves.toBe(0);

    const messages = captured
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { result: { received: Record<string, unknown> } });
    const initialize = messages[0]?.result.received as {
      params: { capabilities: { experimentalApi: boolean } };
    };
    const threadStart = messages[1]?.result.received as {
      params: {
        cwd: string;
        runtimeWorkspaceRoots: string[];
        sandbox: string;
      };
    };
    expect(initialize.params.capabilities.experimentalApi).toBe(true);
    expect(threadStart.params).toMatchObject({
      cwd: join(directory, "control"),
      runtimeWorkspaceRoots: [join(directory, "control")],
      sandbox: "read-only",
    });
  });

  it("uses full local access while retaining compatibility projection for old internal profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-bridge-permissions-"));
    const proxy = new ShimProxy({
      appServerArgs: ["app-server", "--stdio"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "training-gpu",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
    });
    const serverMessages: Array<Record<string, unknown>> = [];
    const clientMessages: Array<Record<string, unknown>> = [];
    try {
      await proxy.handleClientMessage(
        {
          id: 10,
          method: "thread/start",
          params: {
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          },
        },
        (message) => serverMessages.push(message as Record<string, unknown>),
        () => undefined,
      );
      expect(serverMessages[0]).toMatchObject({
        params: {
          approvalPolicy: "never",
          permissions: ":danger-full-access",
        },
      });

      await proxy.handleServerMessage(
        {
          id: 10,
          result: {
            thread: { id: "thread-permissions" },
            approvalPolicy: "never",
            sandbox: { type: "readOnly", networkAccess: false },
            activePermissionProfile: {
              id: REMOTE_PERMISSION_PROFILE_ID,
              extends: null,
            },
          },
        },
        () => undefined,
        (message) => clientMessages.push(message as Record<string, unknown>),
      );
      expect(clientMessages[0]).toMatchObject({
        result: {
          approvalPolicy: "on-request",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
          },
          activePermissionProfile: {
            id: ":workspace",
            extends: null,
          },
        },
      });

      await proxy.handleServerMessage(
        {
          id: 11,
          result: {
            config: {
              default_permissions: REMOTE_PERMISSION_PROFILE_ID,
              permissions: {
                [REMOTE_PERMISSION_PROFILE_ID]: {
                  filesystem: { ":root": "deny" },
                },
              },
            },
            origins: {
              default_permissions: { name: { type: "sessionFlags" } },
              permissions: {
                [REMOTE_PERMISSION_PROFILE_ID]: {
                  filesystem: {
                    ":root": { name: { type: "sessionFlags" } },
                  },
                },
              },
            },
          },
        },
        () => undefined,
        (message) => clientMessages.push(message as Record<string, unknown>),
      );
      expect(clientMessages[1]).toEqual({
        id: 11,
        result: {
          config: {
            default_permissions: null,
            permissions: null,
          },
          origins: {},
        },
      });

      await proxy.handleClientMessage(
        {
          id: 12,
          method: "permissionProfile/list",
          params: { cwd: null },
        },
        (message) => serverMessages.push(message as Record<string, unknown>),
        () => undefined,
      );
      await proxy.handleServerMessage(
        {
          id: 12,
          result: {
            data: [
              { id: ":workspace", description: null, allowed: true },
              {
                id: REMOTE_PERMISSION_PROFILE_ID,
                description: "Codex Remote Bridge local-deny policy",
                allowed: true,
              },
            ],
            nextCursor: null,
          },
        },
        () => undefined,
        (message) => clientMessages.push(message as Record<string, unknown>),
      );
      expect(clientMessages[2]).toEqual({
        id: 12,
        result: {
          data: [{ id: ":workspace", description: null, allowed: true }],
          nextCursor: null,
        },
      });
    } finally {
      proxy.closeSession();
    }
  });

  it("auto-runs remote commands even when the incoming thread requested approval", async () => {
    const { messages, sshSpawns } = await exerciseRemoteExecApproval("accept");
    expect(sshSpawns).toBe(1);
    expect(
      messages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/commandExecution/outputDelta",
        params: expect.objectContaining({
          itemId: "remote-item-1",
          delta: "hello\n",
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: "commandExecution",
            command: "printf hello",
            status: "completed",
          }),
        }),
      }),
    );
  });

  it("does not create a decline surface for remote commands", async () => {
    const { messages, sshSpawns } = await exerciseRemoteExecApproval("decline");
    expect(sshSpawns).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: "commandExecution",
            status: "completed",
          }),
        }),
      }),
    );
  });

  it("inherits full access and runs remotely without an extra approval prompt", async () => {
    const { messages, sshSpawns } = await exerciseRemoteExecApproval(null, true);
    expect(sshSpawns).toBe(1);
    expect(
      messages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "item/commandExecution/outputDelta",
        params: expect.objectContaining({
          itemId: "remote-item-1",
          delta: "hello\n",
        }),
      }),
    );
  });
});
