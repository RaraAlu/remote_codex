import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const stateDir = await mkdtemp(join(tmpdir(), "codex-bridge-smoke-"));
const codexHome = join(stateDir, "codex-home");
await mkdir(codexHome, { mode: 0o700 });

try {
  const shim = resolve("dist/codex-bridge-shim.cjs");
  const child = spawn(shim, ["app-server", "--stdio"], {
    env: {
      ...process.env,
      CODEX_BRIDGE_CONFIG: join(stateDir, "missing-config.json"),
      CODEX_BRIDGE_STATE_DIR: stateDir,
      CODEX_HOME: codexHome,
    },
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
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  child.stdin.end();

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
  const initialize = messages.find((message) => message.id === 1);
  if (!initialize?.result?.userAgent?.includes("codex_bridge_smoke")) {
    throw new Error(`Missing app-server initialize response: ${stdout}`);
  }

  const audit = await readFile(join(stateDir, "audit.jsonl"), "utf8");
  if (!audit.includes('"operation":"shim.start"')) {
    throw new Error("Shim start was not recorded in the local audit log");
  }
  const controlMode = (await stat(join(stateDir, "control"))).mode & 0o777;
  if (controlMode !== 0o500) {
    throw new Error(`Control directory mode is ${controlMode.toString(8)}, expected 500`);
  }
  process.stdout.write("Shim smoke test passed: local app-server initialize over JSONL\n");
} finally {
  await rm(stateDir, { force: true, recursive: true });
}
