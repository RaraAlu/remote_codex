import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { OpenSshExecutor } from "../src/core/ssh-executor.js";
import { ShimProxy } from "../src/shim/proxy.js";

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

describe.skipIf(!enabled)("real OpenSSH read-only acceptance", () => {
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
});
