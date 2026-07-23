import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { loadOfficialCodexRuntime } from "../src/core/codex-runtime-store.js";
import { officialCodexRuntimePath } from "../src/core/locations.js";
import { OpenSshExecutor } from "../src/core/ssh-executor.js";
import { ShimProxy } from "../src/shim/proxy.js";
import { routeRemoteMcpServers } from "../src/shim/remote-mcp.js";

const enabled = process.env.CODEX_BRIDGE_REMOTE_TEST === "1";

function remoteConfig() {
  const host = process.env.CODEX_BRIDGE_TEST_HOST;
  const workspaceRoot = process.env.CODEX_BRIDGE_TEST_WORKSPACE;
  if (!host || !workspaceRoot) {
    throw new Error("CODEX_BRIDGE_TEST_HOST and CODEX_BRIDGE_TEST_WORKSPACE are required");
  }
  return parseBridgeConfig({
    host,
    workspaceRoot,
    sshUser: process.env.CODEX_BRIDGE_TEST_USER || undefined,
    sshPort: process.env.CODEX_BRIDGE_TEST_PORT
      ? Number(process.env.CODEX_BRIDGE_TEST_PORT)
      : undefined,
    identityFile: process.env.CODEX_BRIDGE_TEST_IDENTITY || undefined,
    commandTimeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
}

function fakeToolCallingAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    process.stdout.write(JSON.stringify({
      id: 99,
      method: "item/tool/call",
      params: {
        arguments: { path: "README.md", limitBytes: 4096 },
        callId: "remote_acceptance_read",
        threadId: "thread_test",
        tool: "remote_read_file",
        turnId: "turn_test"
      }
    }) + "\\n");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === 99) {
        process.stdout.write(JSON.stringify({
          method: "bridge/testResult",
          params: message.result
        }) + "\\n");
        process.exit(0);
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

function fakeRemoteExecAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    process.stdout.write(JSON.stringify({
      id: 100,
      method: "item/tool/call",
      params: {
        arguments: { argv: ["pwd"] },
        callId: "remote_acceptance_exec",
        threadId: "thread_test",
        tool: "remote_exec",
        turnId: "turn_test"
      }
    }) + "\\n");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === 100) {
        process.stdout.write(JSON.stringify({
          method: "bridge/testResult",
          params: message.result
        }) + "\\n");
        process.exit(0);
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

function fakeFullAccessRemoteExecAppServer(): ChildProcessWithoutNullStreams {
  const source = `
    const readline = require("node:readline");
    const call = {
      arguments: { argv: ["pwd"] },
      callId: "remote_full_access_exec",
      threadId: "thread_full_access",
      tool: "remote_exec",
      turnId: "turn_full_access"
    };
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "thread/start") {
        process.stdout.write(JSON.stringify({
          id: message.id,
          result: { thread: { id: call.threadId } }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          id: 101,
          method: "item/tool/call",
          params: call
        }) + "\\n");
        return;
      }
      if (message.id === 101) {
        process.stdout.write(JSON.stringify({
          method: "bridge/testResult",
          params: message.result
        }) + "\\n");
        process.exit(0);
      }
    });
  `;
  return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
}

async function callCodegraphOverStdio(
  command: string,
  args: string[],
  workspaceRoot: string,
): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Remote MCP timed out: ${stderr}`));
    }, 30_000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as {
          id?: number;
          result?: Record<string, unknown>;
        };
        if (message.id === 1) {
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {},
            })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "codegraph_explore",
                arguments: {
                  projectPath: workspaceRoot,
                  query: "package.json package name",
                  maxFiles: 1,
                },
              },
            })}\n`,
          );
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          child.stdin.end();
          resolvePromise(message.result);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "codex-bridge-test", version: "1.0" },
        },
      })}\n`,
    );
  });
}

describe.skipIf(!enabled)("real OpenSSH bridge acceptance", () => {
  it(
    "proves identity, repository reads, grep fallback, Git, GPU, and safe path failure",
    async () => {
      const config = remoteConfig();
      const { host, workspaceRoot } = config;
      const executor = new OpenSshExecutor(config);

      try {
        const identity = await executor.probe();
        expect(identity.hostId).toBe(host);
        expect(identity.hostname).not.toBe("");
        expect(identity.machineId).toMatch(/^[a-f0-9]{32}$/);
        expect(identity.workspaceRoot).toBe(workspaceRoot);

        const remoteCodex = await executor.execute([
          "sh",
          "-c",
          "command -v codex >/dev/null 2>&1",
        ]);
        expect(remoteCodex.exitCode).not.toBe(0);

        const readme = await executor.readFile("README.md", 256 * 1024);
        expect(readme.canonicalPath).toBe(`${workspaceRoot}/README.md`);
        expect(readme.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(readme.size).toBeGreaterThan(0);
        expect(Buffer.from(readme.contentBase64, "base64").length).toBeGreaterThan(0);

        const entries = await executor.listDirectory(".");
        expect(entries).toContainEqual({ name: "README.md", type: "file" });

        const matches = await executor.search("MimicLite", ["README.md"], 20);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0]?.path).toContain("README.md");

        const gitStatus = await executor.execute(["git", "status", "--short", "--branch"]);
        expect(gitStatus.exitCode).toBe(0);
        expect(gitStatus.actualCwd).toBe(workspaceRoot);
        expect(gitStatus.stdout).toContain("## ");

        const gpu = await executor.execute([
          "nvidia-smi",
          "--query-gpu=name",
          "--format=csv,noheader",
        ]);
        expect(gpu.exitCode).toBe(0);
        expect(gpu.stdout).toContain("NVIDIA");

        await expect(executor.canonicalPath("/etc/passwd")).rejects.toMatchObject({
          code: "PATH_OUTSIDE_ROOT",
        });
        await expect(
          executor.canonicalPath(
            "active-adaptation/venv/mjlab/.venv/bin/python",
          ),
        ).rejects.toMatchObject({
          code: "PATH_OUTSIDE_ROOT",
        });
      } finally {
        executor.close();
      }
    },
    120_000,
  );

  it(
    "routes a real remote_read_file dynamic tool call through the JSONL shim",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-bridge-remote-shim-"));
      const input = new PassThrough();
      const output = new PassThrough();
      let captured = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        captured += chunk;
      });
      try {
        const proxy = new ShimProxy({
          appServerArgs: ["app-server", "--stdio"],
          auditPath: join(directory, "audit.jsonl"),
          codexExecutable: "fake-codex",
          config: remoteConfig(),
          controlDir: join(directory, "control"),
          input,
          output,
          errorOutput: new PassThrough(),
          spawnCodex: () => fakeToolCallingAppServer(),
        });
        await expect(proxy.run()).resolves.toBe(0);

        const notification = captured
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
          .find((message) => message.method === "bridge/testResult");
        const dynamicResult = notification?.params as {
          success: boolean;
          contentItems: Array<{ text: string }>;
        };
        expect(dynamicResult.success).toBe(true);
        const toolResult = JSON.parse(dynamicResult.contentItems[0]?.text ?? "{}") as {
          ok: boolean;
          hostId: string;
          data: { hash: string; canonicalPath: string };
        };
        expect(toolResult).toMatchObject({
          ok: true,
          hostId: process.env.CODEX_BRIDGE_TEST_HOST,
        });
        expect(toolResult.data.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(toolResult.data.canonicalPath).toBe(
          `${process.env.CODEX_BRIDGE_TEST_WORKSPACE}/README.md`,
        );
      } finally {
        input.destroy();
        await rm(directory, { force: true, recursive: true });
      }
    },
    120_000,
  );

  it(
    "scans local MCPs and relays a real CodeGraph call to the remote index",
    async () => {
      const config = parseBridgeConfig({
        ...remoteConfig(),
        remoteMcpAccess: "all",
      });
      const runtime = await loadOfficialCodexRuntime(officialCodexRuntimePath());
      const routing = await routeRemoteMcpServers({
        appServerArgs: ["app-server"],
        codexExecutable: runtime.executable,
        config,
      });
      expect(routing.remoteServers).toContain("codegraph");
      for (const name of ["blender", "codegraph"]) {
        expect(routing.appServerArgs).toContain(
          `mcp_servers.${name}.enabled=true`,
        );
        expect(routing.appServerArgs).toContain(
          `mcp_servers.${name}.disabled_tools=[]`,
        );
        expect(routing.appServerArgs).toContain(
          `mcp_servers.${name}.default_tools_approval_mode="approve"`,
        );
      }

      const commandIndex = routing.appServerArgs.findIndex((entry) =>
        entry.startsWith("mcp_servers.codegraph.command="),
      );
      expect(commandIndex).toBeGreaterThan(-1);
      const argsOverride = routing.appServerArgs[commandIndex + 2] ?? "";
      const encodedArgs = argsOverride.slice(argsOverride.indexOf("=") + 1);
      const sshArgs = JSON.parse(encodedArgs) as string[];
      const result = await callCodegraphOverStdio("ssh", sshArgs, config.workspaceRoot);
      expect(result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain("not initialized");
      expect(JSON.stringify(result)).toContain("package.json");
    },
    120_000,
  );

  it(
    "requires approval and streams a real remote_exec through the JSONL shim",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-bridge-remote-exec-"));
      const input = new PassThrough();
      const output = new PassThrough();
      const messages: Array<Record<string, unknown>> = [];
      let buffer = "";
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
          const message: unknown = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            continue;
          }
          const record = message as Record<string, unknown>;
          messages.push(record);
          if (
            record.method === "item/commandExecution/requestApproval" &&
            (typeof record.id === "string" || typeof record.id === "number")
          ) {
            input.write(
              `${JSON.stringify({ id: record.id, result: { decision: "accept" } })}\n`,
            );
          }
        }
      });
      try {
        const config = remoteConfig();
        const proxy = new ShimProxy({
          appServerArgs: ["app-server", "--stdio"],
          auditPath: join(directory, "audit.jsonl"),
          codexExecutable: "fake-codex",
          config,
          controlDir: join(directory, "control"),
          input,
          output,
          errorOutput: new PassThrough(),
          spawnCodex: () => fakeRemoteExecAppServer(),
        });
        await expect(proxy.run()).resolves.toBe(0);

        expect(messages).toContainEqual(
          expect.objectContaining({
            method: "item/commandExecution/requestApproval",
            params: expect.objectContaining({
              command: "pwd",
              cwd: config.workspaceRoot,
            }),
          }),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            method: "item/commandExecution/outputDelta",
            params: expect.objectContaining({
              delta: `${config.workspaceRoot}\n`,
            }),
          }),
        );
        const notification = messages.find(
          (message) => message.method === "bridge/testResult",
        );
        const dynamicResult = notification?.params as {
          success: boolean;
          contentItems: Array<{ text: string }>;
        };
        expect(dynamicResult.success).toBe(true);
        const toolResult = JSON.parse(dynamicResult.contentItems[0]?.text ?? "{}") as {
          ok: boolean;
          data: { actualCwd: string; stdout: string };
        };
        expect(toolResult).toMatchObject({
          ok: true,
          data: {
            actualCwd: config.workspaceRoot,
            stdout: `${config.workspaceRoot}\n`,
          },
        });
      } finally {
        input.destroy();
        await rm(directory, { force: true, recursive: true });
      }
    },
    120_000,
  );

  it(
    "inherits full access and executes remote_exec without prompting",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-bridge-remote-full-"));
      const input = new PassThrough();
      const output = new PassThrough();
      const messages: Array<Record<string, unknown>> = [];
      let buffer = "";
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
          const message: unknown = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            continue;
          }
          const record = message as Record<string, unknown>;
          messages.push(record);
          if (
            record.method === "item/commandExecution/requestApproval" &&
            (typeof record.id === "string" || typeof record.id === "number")
          ) {
            input.write(
              `${JSON.stringify({ id: record.id, result: { decision: "decline" } })}\n`,
            );
          }
        }
      });
      try {
        const config = remoteConfig();
        const proxy = new ShimProxy({
          appServerArgs: ["app-server", "--stdio"],
          auditPath: join(directory, "audit.jsonl"),
          codexExecutable: "fake-codex",
          config,
          controlDir: join(directory, "control"),
          input,
          output,
          errorOutput: new PassThrough(),
          spawnCodex: () => fakeFullAccessRemoteExecAppServer(),
        });
        const running = proxy.run();
        input.write(
          `${JSON.stringify({
            id: 1,
            method: "thread/start",
            params: { permissions: "full-access" },
          })}\n`,
        );
        await expect(running).resolves.toBe(0);

        expect(
          messages.some(
            (message) => message.method === "item/commandExecution/requestApproval",
          ),
        ).toBe(false);
        expect(messages).toContainEqual(
          expect.objectContaining({
            method: "item/commandExecution/outputDelta",
            params: expect.objectContaining({
              delta: `${config.workspaceRoot}\n`,
            }),
          }),
        );
        const notification = messages.find(
          (message) => message.method === "bridge/testResult",
        );
        const dynamicResult = notification?.params as {
          success: boolean;
          contentItems: Array<{ text: string }>;
        };
        expect(dynamicResult.success).toBe(true);
      } finally {
        input.destroy();
        await rm(directory, { force: true, recursive: true });
      }
    },
    120_000,
  );
});
