import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function bundledExecutable(extensionPath) {
  if (process.arch !== "x64") {
    throw new Error(`Unsupported official Codex runtime architecture: ${process.arch}`);
  }
  if (process.platform === "linux") {
    return join(extensionPath, "bin", "linux-x86_64", "codex");
  }
  if (process.platform === "win32") {
    return join(extensionPath, "bin", "windows-x86_64", "codex.exe");
  }
  throw new Error(`Unsupported official Codex runtime platform: ${process.platform}`);
}

async function readOfficialExtension(extensionPath) {
  try {
    const packageJson = JSON.parse(
      await readFile(join(extensionPath, "package.json"), "utf8"),
    );
    if (
      packageJson.publisher !== "openai" ||
      packageJson.name !== "chatgpt" ||
      typeof packageJson.version !== "string"
    ) {
      return null;
    }
    const executable = bundledExecutable(extensionPath);
    await access(executable);
    return {
      executable,
      extensionPath,
      extensionVersion: packageJson.version,
    };
  } catch {
    return null;
  }
}

async function codexNpmPackageExecutable() {
  const npmPackage = process.env.CODEX_BRIDGE_CODEX_NPM_PACKAGE;
  if (!npmPackage) {
    return null;
  }
  const root = resolve(process.cwd(), "node_modules", npmPackage, "vendor");
  const platformVendorDirectory =
    process.platform === "linux"
      ? "x86_64-unknown-linux-musl"
      : process.platform === "win32"
        ? "x86_64-pc-windows-msvc"
        : null;
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  if (!platformVendorDirectory) {
    throw new Error(
      `Unsupported official Codex npm package platform: ${process.platform}`,
    );
  }
  const executable = resolve(root, platformVendorDirectory, "bin", executableName);
  try {
    await access(executable);
  } catch {
    // The named npm package is not installed for this platform (e.g. a
    // Linux-only package on a Windows host). Fall through to other sources.
    return null;
  }
  return { executable, npmPackage };
}

export async function findOfficialCodexRuntime() {
  const developmentExecutable =
    process.env.CODEX_BRIDGE_DEVELOPMENT_CODEX_EXECUTABLE;
  if (developmentExecutable) {
    const extensionVersion =
      process.env.CODEX_BRIDGE_DEVELOPMENT_EXTENSION_VERSION;
    if (!extensionVersion) {
      throw new Error(
        "CODEX_BRIDGE_DEVELOPMENT_EXTENSION_VERSION is required with the development executable override",
      );
    }
    const executable = resolve(developmentExecutable);
    await access(executable);
    return {
      executable,
      extensionPath: null,
      extensionVersion,
    };
  }

  const explicitExtensionPath =
    process.env.CODEX_BRIDGE_OFFICIAL_EXTENSION_PATH;
  if (explicitExtensionPath) {
    const runtime = await readOfficialExtension(resolve(explicitExtensionPath));
    if (!runtime) {
      throw new Error(
        `Invalid official OpenAI Codex extension path: ${explicitExtensionPath}`,
      );
    }
    return runtime;
  }

  const npmPackageExecutable = await codexNpmPackageExecutable();
  if (npmPackageExecutable) {
    return {
      executable: npmPackageExecutable.executable,
      extensionPath: null,
      extensionVersion: npmPackageExecutable.npmPackage,
    };
  }

  const roots = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
  ];
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) {
        continue;
      }
      const runtime = await readOfficialExtension(join(root, entry.name));
      if (runtime) {
        candidates.push(runtime);
      }
    }
  }
  candidates.sort((left, right) =>
    new Intl.Collator("en", { numeric: true }).compare(
      right.extensionVersion,
      left.extensionVersion,
    ),
  );
  const runtime = candidates[0];
  if (!runtime) {
    throw new Error(
      "The official OpenAI Codex VS Code extension with a bundled runtime was not found",
    );
  }
  return runtime;
}
