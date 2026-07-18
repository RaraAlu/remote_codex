import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appServerArgs = [
  "-c",
  "features.code_mode_host=true",
  "app-server",
  "--analytics-default-enabled",
];

function appServerEnvironment(stateDir, codexHome, sessionConfigPath = null) {
  const environment = {
    ...process.env,
    CODEX_BRIDGE_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
  };
  delete environment.CODEX_BRIDGE_CONFIG;
  delete environment.CODEX_BRIDGE_SESSION_CONFIG;
  if (sessionConfigPath) {
    environment.CODEX_BRIDGE_SESSION_CONFIG = sessionConfigPath;
  }
  return environment;
}

async function runHandshake(shim, environment, startThread = false) {
  const child = spawn(shim, appServerArgs, {
    env: environment,
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let threadListRequested = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id === 1 && !threadListRequested) {
        threadListRequested = true;
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        child.stdin.write(
          `${JSON.stringify({
            id: 2,
            method: "thread/list",
            params: {
              limit: 1,
              sourceKinds: ["vscode"],
            },
          })}\n`,
        );
      } else if (message.id === 2) {
        if (startThread) {
          child.stdin.write(
            `${JSON.stringify({
              id: 3,
              method: "thread/start",
              params: {
                permissions: "full-access",
              },
            })}\n`,
          );
        } else {
          child.stdin.end();
        }
      } else if (message.id === 3) {
        child.stdin.end();
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.write(
    `${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_bridge_smoke",
          title: "Codex Bridge Smoke",
          version: "0.1.0",
        },
      },
    })}\n`,
  );

  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  timeout.unref();
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code));
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(`Shim exited with ${exitCode}: ${stderr}`);
  }
  const messages = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { messages, stdout };
}

function assertHandshake({ messages, stdout }) {
  const initialize = messages.find((message) => message.id === 1);
  if (!initialize?.result?.userAgent?.includes("codex_bridge_smoke")) {
    throw new Error(`Missing app-server initialize response: ${stdout}`);
  }
  const threadList = messages.find((message) => message.id === 2);
  if (!Array.isArray(threadList?.result?.data)) {
    throw new Error(`Missing app-server thread/list response: ${stdout}`);
  }
}

function assertThreadStarted({ messages, stdout }) {
  const threadStart = messages.find((message) => message.id === 3);
  if (!threadStart?.result?.thread?.id) {
    throw new Error(`Missing app-server thread/start response: ${stdout}`);
  }
}

const rootDir = await mkdtemp(join(tmpdir(), "codex-bridge-smoke-"));
const shim = resolve(
  process.platform === "win32"
    ? "dist/codex-bridge-shim.exe"
    : "dist/codex-bridge-shim.cjs",
);

try {
  const localStateDir = join(rootDir, "local-state");
  const localCodexHome = join(rootDir, "local-codex-home");
  await mkdir(localCodexHome, { mode: 0o700, recursive: true });
  const localHandshake = await runHandshake(
    shim,
    appServerEnvironment(localStateDir, localCodexHome),
  );
  assertHandshake(localHandshake);
  const localAudit = await readFile(join(localStateDir, "audit.jsonl"), "utf8").catch(
    (error) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    },
  );
  if (localAudit.includes('"operation":"shim.start"')) {
    throw new Error("Local app-server invocation was unexpectedly intercepted by the bridge");
  }

  const remoteStateDir = join(rootDir, "remote-state");
  const remoteCodexHome = join(rootDir, "remote-codex-home");
  const sessionConfigPath = join(remoteStateDir, "sessions", "smoke.json");
  await mkdir(remoteCodexHome, { mode: 0o700, recursive: true });
  await mkdir(join(remoteStateDir, "sessions"), { mode: 0o700, recursive: true });
  await writeFile(
    sessionConfigPath,
    `${JSON.stringify({
      version: 1,
      host: "example.invalid",
      workspaceRoot: "/tmp/remote-workspace",
      connectionMode: "openssh",
      localExecution: "deny",
      remoteHelper: "none",
      remoteMcpRouting: "local",
      remoteMcpAccess: "enabled",
      codexExecutable: "codex",
      commandTimeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
      maxParallelReads: 8,
      maxParallelWrites: 1,
      connectTimeoutSeconds: 10,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const remoteHandshake = await runHandshake(
    shim,
    appServerEnvironment(remoteStateDir, remoteCodexHome, sessionConfigPath),
    true,
  );
  assertHandshake(remoteHandshake);
  assertThreadStarted(remoteHandshake);

  const remoteAudit = await readFile(join(remoteStateDir, "audit.jsonl"), "utf8");
  if (!remoteAudit.includes('"operation":"shim.start"')) {
    throw new Error("Remote window shim start was not recorded in the audit log");
  }
  if (process.platform !== "win32") {
    const controlMode = (await stat(join(remoteStateDir, "control"))).mode & 0o777;
    if (controlMode !== 0o500) {
      throw new Error(`Control directory mode is ${controlMode.toString(8)}, expected 500`);
    }
  }
  process.stdout.write(
    "Shim smoke test passed: local passthrough plus remote-window startup and thread creation\n",
  );
} finally {
  await rm(rootDir, { force: true, recursive: true });
}
