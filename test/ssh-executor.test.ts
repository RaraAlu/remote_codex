import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { BridgeError } from "../src/core/errors.js";
import {
  buildRemoteCommand,
  buildSshEnvironment,
  buildSshArgs,
  OpenSshExecutor,
  quotePosix,
  type SpawnProcess,
} from "../src/core/ssh-executor.js";

const config = parseBridgeConfig({
  host: "training-gpu",
  workspaceRoot: "/remote/workspace",
  commandTimeoutMs: 1_000,
  maxOutputBytes: 1_024,
});

function nodeChild(script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", script], {
    stdio: "pipe",
  });
}

describe("OpenSSH command construction", () => {
  it("quotes newlines, spaces, and single quotes without shell reinterpretation", () => {
    const value = "space and 'quote'\nnext";
    const command = buildRemoteCommand("/tmp", ["printf", "%s", value]);
    const result = spawnSync("sh", ["-c", command]);
    expect(result.status).toBe(0);
    const delimiter = result.stdout.indexOf(0);
    expect(result.stdout.subarray(delimiter + 1).toString()).toBe(value);
  });

  it("keeps strict host checking enabled by omission and uses a concrete host operand", () => {
    const args = buildSshArgs(config, "true");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).not.toContain("StrictHostKeyChecking=no");
    expect(args.slice(-2)).toEqual(["training-gpu", "true"]);
    expect(quotePosix("a'b")).toBe("'a'\"'\"'b'");
  });

  it("does not expose Codex or API credentials to the OpenSSH process", () => {
    const environment = buildSshEnvironment({
      HOME: "/home/user",
      SSH_AUTH_SOCK: "/run/agent.sock",
      CODEX_ACCESS_TOKEN: "chatgpt-secret",
      OPENAI_API_KEY: "api-secret",
      DATABASE_PASSWORD: "db-secret",
      CUSTOM_VALUE: "not-required-by-ssh",
    });
    expect(environment).toEqual({
      HOME: "/home/user",
      SSH_AUTH_SOCK: "/run/agent.sock",
    });
  });
});

describe("OpenSshExecutor execution", () => {
  it("returns remote cwd, output, exit status, and duration", async () => {
    let capturedCommand = "";
    const fakeSpawn: SpawnProcess = (_command, args) => {
      capturedCommand = args.at(-1) ?? "";
      return nodeChild(
        "process.stdout.write('/remote/workspace\\0hello'); process.stderr.write('notice');",
      );
    };
    const executor = new OpenSshExecutor(config, fakeSpawn);
    const result = await executor.execute(["printf", "hello"]);
    expect(capturedCommand).toContain("printf");
    expect(result).toMatchObject({
      actualCwd: "/remote/workspace",
      exitCode: 0,
      stderr: "notice",
      stdout: "hello",
      truncated: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("retains only the output tail and marks truncation", async () => {
    const fakeSpawn: SpawnProcess = () =>
      nodeChild("process.stdout.write('/remote/workspace\\0' + 'x'.repeat(2000));");
    const executor = new OpenSshExecutor(config, fakeSpawn);
    const result = await executor.execute(["true"]);
    expect(result.stdout).toHaveLength(1_024);
    expect(result.truncated).toBe(true);
  });

  it("classifies host key failures without retrying locally", async () => {
    const fakeSpawn: SpawnProcess = () =>
      nodeChild(
        "process.stderr.write('REMOTE HOST IDENTIFICATION HAS CHANGED'); process.exitCode = 255;",
      );
    const executor = new OpenSshExecutor(config, fakeSpawn);
    await expect(executor.execute(["true"])).rejects.toMatchObject({
      code: "HOST_KEY_MISMATCH",
      retryable: false,
    } satisfies Partial<BridgeError>);
  });

  it("reports unknown side effects after a timeout", async () => {
    const fakeSpawn: SpawnProcess = () => nodeChild("setInterval(() => {}, 1000);");
    const executor = new OpenSshExecutor(config, fakeSpawn);
    await expect(
      executor.execute(["long-command"], { sideEffect: true, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: "RESULT_UNKNOWN",
    });
  });
});
