import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { inject } = require("postject");
const execFileAsync = promisify(execFile);

await mkdir("dist", { recursive: true });

await Promise.all([
  build({
    bundle: true,
    entryPoints: ["src/extension/extension.ts"],
    external: ["vscode"],
    format: "cjs",
    logLevel: "info",
    outfile: "dist/extension.cjs",
    platform: "node",
    sourcemap: true,
    target: "node20",
  }),
  build({
    banner: { js: "#!/usr/bin/env node" },
    bundle: true,
    entryPoints: ["src/shim/main.ts"],
    format: "cjs",
    logLevel: "info",
    outfile: "dist/codex-bridge-shim.cjs",
    platform: "node",
    sourcemap: true,
    target: "node20",
  }),
  build({
    bundle: true,
    entryPoints: ["src/remote-extension/extension.ts"],
    external: ["vscode"],
    format: "cjs",
    logLevel: "info",
    outfile: "remote-executor/dist/extension.cjs",
    platform: "node",
    sourcemap: true,
    target: "node20",
  }),
]);

if (process.platform === "win32") {
  const shim = resolve("dist/codex-bridge-shim.cjs");
  const executable = resolve("dist/codex-bridge-shim.exe");
  const blob = resolve("dist/codex-bridge-shim.blob");
  const seaConfig = resolve("dist/codex-bridge-shim.sea.json");
  await writeFile(
    seaConfig,
    `${JSON.stringify(
      {
        main: shim,
        output: blob,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    )}\n`,
  );
  try {
    await execFileAsync(process.execPath, ["--experimental-sea-config", seaConfig], {
      windowsHide: true,
    });
    await copyFile(process.execPath, executable);
    await inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
      overwrite: true,
      sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    });
  } finally {
    await rm(blob, { force: true });
    await rm(seaConfig, { force: true });
  }
} else {
  await rm("dist/codex-bridge-shim.exe", { force: true });
  await chmod("dist/codex-bridge-shim.cjs", 0o755);
}
