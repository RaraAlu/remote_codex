import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { findOfficialCodexRuntime } from "./official-codex.mjs";

const officialRuntime = await findOfficialCodexRuntime();
const bundledCodexVersion = execFileSync(
  officialRuntime.executable,
  ["--version"],
  { encoding: "utf8" },
)
  .trim()
  .replace(/^codex-cli\s+/, "");

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
  delete environment.CODEX_BRIDGE_CODEX_EXECUTABLE;
  delete environment.CODEX_BRIDGE_DEVELOPMENT_CODEX_EXECUTABLE;
  if (sessionConfigPath) {
    environment.CODEX_BRIDGE_SESSION_CONFIG = sessionConfigPath;
  }
  return environment;
}

async function writeRuntimeMetadata(stateDir) {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  await writeFile(
    join(stateDir, "official-codex-runtime.json"),
    `${JSON.stringify({
      source: "official-extension",
      executable: officialRuntime.executable,
      extensionVersion: officialRuntime.extensionVersion,
      codexVersion: bundledCodexVersion,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function runHandshake(
  shim,
  environment,
  startThread = false,
  onThreadStarted = null,
  requestFullAccess = true,
) {
  const child = spawn(shim, appServerArgs, {
    env: environment,
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let threadListRequested = false;
  let externalProbe = null;
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
                cwd: process.cwd(),
                ...(requestFullAccess ? { permissions: "full-access" } : {}),
              },
            })}\n`,
          );
        } else {
          child.stdin.end();
        }
      } else if (message.id === 3) {
        if (onThreadStarted && !externalProbe) {
          externalProbe = (
            message.result?.thread?.id
              ? onThreadStarted(message.result.thread.id, child.pid)
              : Promise.reject(
                  new Error(
                    `Shim thread creation failed: ${JSON.stringify(message.error ?? message)}`,
                  ),
                )
          ).finally(() => {
            child.stdin.end();
          });
        } else if (!onThreadStarted) {
          child.stdin.end();
        }
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
        capabilities: {
          experimentalApi: true,
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
  await externalProbe;

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

async function assertExternalCliAttach(stateDir, threadId, shimPid) {
  const descriptorPath = join(stateDir, "external-cli", `${shimPid}.json`);
  const deadline = Date.now() + 5_000;
  let descriptor;
  while (Date.now() < deadline) {
    descriptor = await readFile(descriptorPath, "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    if (descriptor?.threadId === threadId) {
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (descriptor?.threadId !== threadId) {
    throw new Error("Shared app-server did not publish the active VS Code thread");
  }
  const token = await readFile(descriptor.tokenPath, "utf8");
  const socket = new WebSocket(descriptor.endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  const responses = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== undefined) {
      responses.set(message.id, message);
    }
  });
  socket.send(
    JSON.stringify({
      id: 101,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_bridge_external_smoke",
          title: "Codex Bridge External Smoke",
          version: "0.1.0",
        },
      },
    }),
  );
  while (!responses.has(101) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  socket.send(
    JSON.stringify({
      id: 102,
      method: "thread/list",
      params: { limit: 1, sourceKinds: ["vscode"] },
    }),
  );
  while (!responses.has(102) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const listed = responses.get(102);
  socket.close();
  if (!Array.isArray(listed?.result?.data)) {
    throw new Error(
      `External CLI gateway could not initialize and list threads: ${JSON.stringify(listed)}`,
    );
  }
}

async function assertMissingRuntimeFailsClosed(shim, stateDir, codexHome) {
  const child = spawn(shim, ["--version"], {
    env: appServerEnvironment(stateDir, codexHome),
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code));
  });
  if (exitCode === 0 || !stderr.includes("runtime metadata is unavailable")) {
    throw new Error(
      `Shim did not fail closed without official runtime metadata: ${stderr}`,
    );
  }
}

async function assertExternalMcpTools(shim, environment) {
  const child = spawn(shim, ["external-mcp"], {
    env: environment,
    stdio: "pipe",
  });
  let buffer = "";
  let stderr = "";
  let tools = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
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
            method: "tools/list",
            params: {},
          })}\n`,
        );
      } else if (message.id === 2) {
        tools = message.result?.tools;
        child.stdin.end();
      }
    }
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bridge-smoke", version: "0.1.0" },
      },
    })}\n`,
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code));
  });
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(`External MCP exited with ${exitCode}: ${stderr}`);
  }
  const names = Array.isArray(tools) ? tools.map((tool) => tool.name).sort() : [];
  const expected = [
    "vscode_codex_interrupt",
    "vscode_codex_intervene",
    "vscode_codex_list_conversations",
    "vscode_codex_read_conversation",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`External MCP tool list is incomplete: ${JSON.stringify(names)}`);
  }
}

async function assertAutomaticCliAttach(shim, rootDir) {
  if (process.platform === "win32") {
    return;
  }
  const stateDir = join(rootDir, "automatic-cli-state");
  const externalCliDir = join(stateDir, "external-cli");
  const binDir = join(rootDir, "automatic-cli-bin");
  const upstream = join(rootDir, "automatic-cli-upstream.mjs");
  const launcher = join(binDir, "codex");
  const tokenPath = join(externalCliDir, `${process.pid}.token`);
  const tokenEnv = "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN";
  const token = "automatic-cli-private-token";
  await mkdir(externalCliDir, { mode: 0o700, recursive: true });
  await mkdir(binDir, { mode: 0o700, recursive: true });
  await writeFile(
    upstream,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'resume' && args[1] === '--help') {",
      "  process.stdout.write('--remote <ADDR>\\n--remote-auth-token-env <ENV_VAR>\\n');",
      "} else {",
      `  process.stdout.write(JSON.stringify({ args, token: process.env.${tokenEnv} }) + '\\n');`,
      "}",
      "",
    ].join("\n"),
  );
  await chmod(upstream, 0o755);
  await symlink(shim, launcher);
  await writeFile(tokenPath, token, { mode: 0o600 });
  await writeFile(
    join(externalCliDir, `${process.pid}.json`),
    `${JSON.stringify({
      version: 1,
      endpoint: "ws://127.0.0.1:65535",
      host: "local",
      pid: process.pid,
      startedAtMs: Date.now(),
      tokenEnv,
      tokenPath,
      workspaceRoot: process.cwd(),
      threadId: "automatic-cli-thread",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(externalCliDir, "integration.json"),
    `${JSON.stringify({
      version: 2,
      codexExecutable: upstream,
      launcherPath: join(binDir, "codex-vscode"),
      shimPath: shim,
      automaticLauncher: {
        launcherPath: launcher,
        originalTarget: upstream,
      },
    })}\n`,
    { mode: 0o600 },
  );

  const child = spawn(launcher, [], {
    cwd: process.cwd(),
    env: appServerEnvironment(stateDir, join(rootDir, "automatic-cli-home")),
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code));
  });
  if (exitCode !== 0) {
    throw new Error(`Automatic plain Codex attach exited with ${exitCode}: ${stderr}`);
  }
  const result = JSON.parse(stdout.trim());
  if (
    result.token !== token ||
    result.args[0] !== "resume" ||
    !result.args.includes("--remote") ||
    !result.args.includes("--remote-auth-token-env") ||
    result.args.at(-1) !== "automatic-cli-thread" ||
    result.args.includes(token)
  ) {
    throw new Error(`Automatic plain Codex attach was not routed safely: ${stdout}`);
  }
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
  if (
    threadStart.result.activePermissionProfile?.id !== "codex-remote-bridge" ||
    threadStart.result.approvalPolicy !== "never" ||
    threadStart.result.sandbox?.type !== "readOnly" ||
    threadStart.result.sandbox?.networkAccess !== false
  ) {
    throw new Error(`Remote local-deny permission profile was not activated: ${stdout}`);
  }
}

function assertLocalThreadStarted({ messages, stdout }) {
  const threadStart = messages.find((message) => message.id === 3);
  if (!threadStart?.result?.thread?.id) {
    throw new Error(`Missing local app-server thread/start response: ${stdout}`);
  }
  if (threadStart.result.activePermissionProfile?.id === "codex-remote-bridge") {
    throw new Error(`Local app-server unexpectedly activated Remote SSH policy: ${stdout}`);
  }
}

const rootDir = await mkdtemp(join(tmpdir(), "codex-bridge-smoke-"));
const shim = resolve(
  process.platform === "win32"
    ? "dist/codex-bridge-shim.exe"
    : "dist/codex-bridge-shim.cjs",
);

try {
  await assertAutomaticCliAttach(shim, rootDir);
  const missingRuntimeHome = join(rootDir, "missing-runtime-codex-home");
  await mkdir(missingRuntimeHome, { mode: 0o700, recursive: true });
  await assertMissingRuntimeFailsClosed(
    shim,
    join(rootDir, "missing-runtime-state"),
    missingRuntimeHome,
  );
  await assertExternalMcpTools(
    shim,
    appServerEnvironment(
      join(rootDir, "external-mcp-state"),
      join(rootDir, "external-mcp-codex-home"),
    ),
  );

  const localStateDir = join(rootDir, "local-state");
  const localCodexHome = join(rootDir, "local-codex-home");
  await writeRuntimeMetadata(localStateDir);
  await mkdir(localCodexHome, { mode: 0o700, recursive: true });
  const localHandshake = await runHandshake(
    shim,
    appServerEnvironment(localStateDir, localCodexHome),
    true,
    (threadId, shimPid) => assertExternalCliAttach(localStateDir, threadId, shimPid),
    false,
  );
  assertHandshake(localHandshake);
  assertLocalThreadStarted(localHandshake);
  const localAudit = await readFile(join(localStateDir, "audit.jsonl"), "utf8");
  const localShimStart = localAudit
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.operation === "shim.start");
  if (
    localShimStart?.details?.bridgeConfigured !== false ||
    localShimStart?.hostId !== "local"
  ) {
    throw new Error("Local app-server did not start the shared local-only gateway");
  }
  if (
    localShimStart.details.appServerArgs.some((arg) =>
      arg.startsWith("default_permissions="),
    )
  ) {
    throw new Error("Local shared app-server unexpectedly received Remote SSH policy");
  }

  const remoteStateDir = join(rootDir, "remote-state");
  const remoteCodexHome = join(rootDir, "remote-codex-home");
  const sessionConfigPath = join(remoteStateDir, "sessions", "smoke.json");
  await writeRuntimeMetadata(remoteStateDir);
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
    (threadId, shimPid) => assertExternalCliAttach(remoteStateDir, threadId, shimPid),
  );
  assertHandshake(remoteHandshake);
  assertThreadStarted(remoteHandshake);

  const remoteAudit = await readFile(join(remoteStateDir, "audit.jsonl"), "utf8");
  if (!remoteAudit.includes('"operation":"shim.start"')) {
    throw new Error("Remote window shim start was not recorded in the audit log");
  }
  const shimStart = remoteAudit
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.operation === "shim.start");
  const auditedAppServerArgs = shimStart?.details?.appServerArgs;
  if (
    !Array.isArray(auditedAppServerArgs) ||
    !auditedAppServerArgs.some((arg) => arg.startsWith("default_permissions=")) ||
    !auditedAppServerArgs.some((arg) =>
      arg.endsWith('filesystem={":root"="deny",":minimal"="read"}'),
    ) ||
    !auditedAppServerArgs.some((arg) => arg.endsWith("network.enabled=false"))
  ) {
    throw new Error(
      `Remote local-deny permission profile is missing from app-server args: ${JSON.stringify(
        shimStart?.details?.appServerArgs,
      )}`,
    );
  }
  if (
    shimStart?.details?.primaryRoot?.path !== "/tmp/remote-workspace" ||
    shimStart?.details?.primaryRoot?.target !== "remote" ||
    shimStart?.details?.primaryRoot?.role !== "primary"
  ) {
    throw new Error("Remote primary workspace identity is missing from the shim audit");
  }
  if (
    typeof shimStart?.details?.controlDirectory?.path !== "string" ||
    !shimStart.details.controlDirectory.path.endsWith("/remote-state/control") ||
    shimStart?.details?.controlDirectory?.target !== "local" ||
    shimStart?.details?.controlDirectory?.role !== "control"
  ) {
    throw new Error("Local control directory identity is missing from the shim audit");
  }
  if (process.platform !== "win32") {
    const controlMode = (await stat(join(remoteStateDir, "control"))).mode & 0o777;
    if (controlMode !== 0o500) {
      throw new Error(`Control directory mode is ${controlMode.toString(8)}, expected 500`);
    }
  }
  process.stdout.write(
    "Shim smoke test passed: missing metadata fails closed, automatic plain CLI attach, external MCP tools, shared local and remote app-server startup, thread creation and authenticated external attach\n",
  );
} finally {
  await rm(rootDir, { force: true, recursive: true });
}
