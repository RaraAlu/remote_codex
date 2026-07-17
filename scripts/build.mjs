import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

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
]);

await chmod("dist/codex-bridge-shim.cjs", 0o755);
