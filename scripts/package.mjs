import { access, copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { createVSIX } = require("@vscode/vsce");
const execFileAsync = promisify(execFile);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const executorPackageJson = JSON.parse(
  await readFile("remote-executor/package.json", "utf8"),
);
const mode = process.argv[2] ?? "current";
const currentTarget =
  process.platform === "win32" && process.arch === "x64"
    ? "win32-x64"
    : process.platform === "linux" && process.arch === "x64"
      ? "linux-x64"
      : null;
const targets = mode === "all" ? ["win32-x64", "linux-x64"] : [currentTarget];

if (targets.some((target) => !target)) {
  throw new Error(`Unsupported packaging host: ${process.platform}-${process.arch}`);
}

const executorPackagePath = resolve(
  "dist",
  `codex-remote-bridge-executor-${executorPackageJson.version}-linux-x64.vsix`,
);
const packagedExecutor = await execFileAsync(
  process.execPath,
  [
    resolve("node_modules", "@vscode", "vsce", "vsce"),
    "package",
    "--allow-missing-repository",
    "--no-dependencies",
    "--target",
    "linux-x64",
    "--out",
    executorPackagePath,
  ],
  {
    cwd: resolve("remote-executor"),
    maxBuffer: 10 * 1024 * 1024,
  },
);
process.stdout.write(packagedExecutor.stdout);
process.stderr.write(packagedExecutor.stderr);
await copyFile(executorPackagePath, resolve("dist", "codex-remote-bridge-executor.vsix"));

for (const target of targets) {
  const launcher =
    target === "win32-x64"
      ? "dist/codex-bridge-shim.exe"
      : "dist/codex-bridge-shim.cjs";
  await access(launcher);
  const packagePath = resolve(
    "dist",
    `codex-remote-bridge-${packageJson.version}-${target}.vsix`,
  );
  await createVSIX({
    allowMissingRepository: true,
    cwd: process.cwd(),
    dependencies: false,
    ignoreFile: resolve(`.vscodeignore.${target}`),
    packagePath,
    target,
  });
}
