import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareChildProcessCommand } from "../core/child-process-command.js";
import { BridgeError } from "../core/errors.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import {
  bridgeExternalCliIntegrationPath,
  bridgeStateDir,
} from "../core/locations.js";
import { isRecord } from "../shim/rpc.js";

const execFileAsync = promisify(execFile);
export const EXTERNAL_MCP_NAME = "codex_vscode_remote_bridge";

export type ExternalMcpReconcileResult = "installed" | "updated" | "unchanged";
export type ExternalCliLauncherReconcileResult = "installed" | "updated" | "unchanged";
export type RunCodexMcp = (
  codexExecutable: string,
  args: readonly string[],
) => Promise<string>;

export function shouldReconcileExternalCliIntegration(
  storedPreference: boolean | undefined,
): boolean {
  return storedPreference !== false;
}

interface CodexMcpConfig {
  transport: {
    args: string[];
    command: string;
    type: string;
  };
}

interface ManagedExternalCliLauncherV1 {
  version: 1;
  codexExecutable: string;
  launcherPath: string;
  shimPath: string;
}

interface ManagedExternalCliLauncherV2 {
  version: 2;
  codexExecutable: string;
  launcherPath: string;
  shimPath: string;
  automaticLauncher: {
    launcherPath: string;
    originalTarget: string;
  } | null;
}

type WindowsAutomaticLauncherKind = "cmd" | "powershell" | "shell";

interface ManagedWindowsAutomaticLauncherEntry {
  backupPath: string;
  kind: WindowsAutomaticLauncherKind;
  launcherPath: string;
}

interface ManagedExternalCliLauncherV3 {
  version: 3;
  codexExecutable: string;
  launcherPath: string;
  shimPath: string;
  automaticLauncher: {
    commandPath: string;
    entries: ManagedWindowsAutomaticLauncherEntry[];
    kind: "windows-npm";
  } | null;
}

type ManagedExternalCliLauncher =
  | ManagedExternalCliLauncherV1
  | ManagedExternalCliLauncherV2
  | ManagedExternalCliLauncherV3;

export interface WindowsAutomaticCliLauncher {
  commandPath: string;
  entries: Array<{
    kind: WindowsAutomaticLauncherKind;
    launcherPath: string;
  }>;
  kind: "windows-npm";
}

export interface ExternalCliLauncherOptions {
  automaticLauncherPath?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  hostPlatform?: NodeJS.Platform;
  integrationPath?: string;
  launcherPath?: string;
  windowsAutomaticLauncher?: WindowsAutomaticCliLauncher;
}

export interface ResolvedExternalCliExecutable {
  automaticLauncherPath?: string;
  commandPath: string;
  executablePath: string;
  windowsAutomaticLauncher?: WindowsAutomaticCliLauncher;
}

function parseMcpConfig(raw: string): CodexMcpConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.transport)) {
    return null;
  }
  const transport = value.transport;
  if (
    transport.type !== "stdio" ||
    typeof transport.command !== "string" ||
    !Array.isArray(transport.args) ||
    !transport.args.every((argument) => typeof argument === "string")
  ) {
    return null;
  }
  return {
    transport: {
      type: transport.type,
      command: transport.command,
      args: transport.args,
    },
  };
}

const runCodexMcp: RunCodexMcp = async (codexExecutable, args) => {
  const invocation = prepareChildProcessCommand(codexExecutable, args);
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
};

async function readExistingMcp(
  codexExecutable: string,
  run: RunCodexMcp,
): Promise<CodexMcpConfig | null> {
  try {
    return parseMcpConfig(
      await run(codexExecutable, ["mcp", "get", EXTERNAL_MCP_NAME, "--json"]),
    );
  } catch {
    return null;
  }
}

export async function reconcileExternalMcp(
  codexExecutable: string,
  shimPath: string,
  run: RunCodexMcp = runCodexMcp,
): Promise<ExternalMcpReconcileResult> {
  const existing = await readExistingMcp(codexExecutable, run);
  if (
    existing?.transport.command === shimPath &&
    existing.transport.args.length === 1 &&
    existing.transport.args[0] === "external-mcp"
  ) {
    return "unchanged";
  }
  if (existing) {
    await run(codexExecutable, ["mcp", "remove", EXTERNAL_MCP_NAME]);
  }
  await run(
    codexExecutable,
    ["mcp", "add", EXTERNAL_MCP_NAME, "--", shimPath, "external-mcp"],
  );
  return existing ? "updated" : "installed";
}

export async function removeExternalMcp(
  codexExecutable: string,
  run: RunCodexMcp = runCodexMcp,
): Promise<boolean> {
  const existing = await readExistingMcp(codexExecutable, run);
  if (!existing) {
    return false;
  }
  await run(codexExecutable, ["mcp", "remove", EXTERNAL_MCP_NAME]);
  return true;
}

function parseManagedLauncher(value: unknown): ManagedExternalCliLauncher | null {
  if (!isRecord(value)) {
    return null;
  }
  const commonFieldsAreValid =
    typeof value.codexExecutable === "string" &&
    typeof value.launcherPath === "string" &&
    typeof value.shimPath === "string";
  if (value.version === 1 && commonFieldsAreValid) {
    return value as unknown as ManagedExternalCliLauncherV1;
  }
  if (value.version === 3 && commonFieldsAreValid) {
    const automatic = value.automaticLauncher;
    if (automatic === null) {
      return value as unknown as ManagedExternalCliLauncherV3;
    }
    if (
      !isRecord(automatic) ||
      automatic.kind !== "windows-npm" ||
      typeof automatic.commandPath !== "string" ||
      !Array.isArray(automatic.entries) ||
      automatic.entries.length !== 3 ||
      !automatic.entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.launcherPath === "string" &&
          typeof entry.backupPath === "string" &&
          ["cmd", "powershell", "shell"].includes(String(entry.kind)),
      ) ||
      new Set(automatic.entries.map((entry) => entry.launcherPath)).size !== 3 ||
      new Set(automatic.entries.map((entry) => entry.kind)).size !== 3
    ) {
      return null;
    }
    const entries = automatic.entries as unknown as ManagedWindowsAutomaticLauncherEntry[];
    const expectedEntries = windowsAutomaticLauncherEntries(automatic.commandPath);
    if (
      !isAbsolute(value.codexExecutable as string) ||
      !isAbsolute(value.launcherPath as string) ||
      !isAbsolute(value.shimPath as string) ||
      !isAbsolute(automatic.commandPath) ||
      !entries.every((entry) => {
        const expected = expectedEntries.find((candidate) => candidate.kind === entry.kind);
        return (
          expected !== undefined &&
          resolve(entry.launcherPath) === resolve(expected.launcherPath) &&
          resolve(entry.backupPath) ===
            resolve(windowsAutomaticLauncherBackupPath(expected))
        );
      })
    ) {
      return null;
    }
    return value as unknown as ManagedExternalCliLauncherV3;
  }
  if (
    value.version !== 2 ||
    !commonFieldsAreValid ||
    !(
      value.automaticLauncher === null ||
      (isRecord(value.automaticLauncher) &&
        typeof value.automaticLauncher.launcherPath === "string" &&
        typeof value.automaticLauncher.originalTarget === "string")
    )
  ) {
    return null;
  }
  return value as unknown as ManagedExternalCliLauncher;
}

async function readManagedLauncher(path: string): Promise<ManagedExternalCliLauncher | null> {
  try {
    return parseManagedLauncher(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw new BridgeError("INVALID_CONFIG", "External CLI launcher metadata is invalid");
  }
}

export function externalCliLauncherPath(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  return hostPlatform === "win32"
    ? join(bridgeStateDir(environment, hostPlatform, homeDirectory), "bin", "codex-vscode.exe")
    : join(homeDirectory, ".local", "bin", "codex-vscode");
}

async function resolveCommandPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  hostPlatform: NodeJS.Platform,
): Promise<string> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const candidates = hasPathSeparator
    ? [resolve(command)]
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => {
          if (hostPlatform !== "win32") {
            return [join(directory, command)];
          }
          const extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean);
          const commandPath = join(directory, command);
          return extensions.some((extension) =>
            command.toLowerCase().endsWith(extension.toLowerCase()),
          )
            ? [commandPath]
            : [
                ...extensions.map((extension) =>
                  join(directory, `${command}${extension.toLowerCase()}`),
                ),
                commandPath,
              ];
        });
  for (const candidate of candidates) {
    try {
      await access(candidate, hostPlatform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH candidates.
    }
  }
  throw new BridgeError(
    "INVALID_CONFIG",
    `External Codex CLI executable was not found: ${command}`,
  );
}

async function symbolicLinkTarget(path: string): Promise<{
  raw: string;
  resolved: string;
} | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSymbolicLink()) {
      return null;
    }
    const raw = await readlink(path);
    return { raw, resolved: resolve(dirname(path), raw) };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function windowsAutomaticLauncherEntries(
  commandPath: string,
): WindowsAutomaticCliLauncher["entries"] {
  const directory = dirname(commandPath);
  return [
    { kind: "shell", launcherPath: join(directory, "codex") },
    { kind: "cmd", launcherPath: join(directory, "codex.cmd") },
    { kind: "powershell", launcherPath: join(directory, "codex.ps1") },
  ];
}

function windowsAutomaticLauncherBackupPath(
  entry: WindowsAutomaticCliLauncher["entries"][number],
): string {
  const suffix =
    entry.kind === "cmd" ? ".cmd" : entry.kind === "powershell" ? ".ps1" : "";
  return join(dirname(entry.launcherPath), `.codex-remote-bridge-original${suffix}`);
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function detectWindowsAutomaticLauncher(
  commandPath: string,
): Promise<WindowsAutomaticCliLauncher | undefined> {
  if (basename(commandPath).toLowerCase() !== "codex.cmd") {
    return undefined;
  }
  const entries = windowsAutomaticLauncherEntries(commandPath);
  if (!(await Promise.all(entries.map((entry) => isRegularFile(entry.launcherPath)))).every(Boolean)) {
    return undefined;
  }
  return { commandPath, entries, kind: "windows-npm" };
}

function managedWindowsAutomaticLauncher(
  managed: ManagedExternalCliLauncher | null,
): ManagedExternalCliLauncherV3["automaticLauncher"] {
  return managed?.version === 3 ? managed.automaticLauncher : null;
}

function windowsAutomaticCandidateFromManaged(
  automatic: NonNullable<ManagedExternalCliLauncherV3["automaticLauncher"]>,
): WindowsAutomaticCliLauncher {
  return {
    commandPath: automatic.commandPath,
    entries: automatic.entries.map(({ kind, launcherPath }) => ({ kind, launcherPath })),
    kind: "windows-npm",
  };
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteShellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function windowsAutomaticLauncherContent(
  kind: WindowsAutomaticLauncherKind,
  launcherPath: string,
): string {
  const marker = "Codex Remote Bridge managed automatic launcher v1";
  if (kind === "cmd") {
    if (/[\0\r\n"%]/.test(launcherPath)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Windows automatic CLI launcher path contains unsupported cmd characters",
      );
    }
    return [
      "@ECHO off",
      `REM ${marker}`,
      `"${launcherPath}" automatic-cli %*`,
      "EXIT /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  if (kind === "powershell") {
    const quoted = quotePowerShellLiteral(launcherPath);
    return [
      "#!/usr/bin/env pwsh",
      `# ${marker}`,
      `$bridge = ${quoted}`,
      "if ($MyInvocation.ExpectingInput) {",
      "  $input | & $bridge 'automatic-cli' @args",
      "} else {",
      "  & $bridge 'automatic-cli' @args",
      "}",
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n");
  }
  const executable = launcherPath.replaceAll("\\", "/");
  return [
    "#!/bin/sh",
    `# ${marker}`,
    `exec ${quoteShellLiteral(executable)} automatic-cli "$@"`,
    "",
  ].join("\n");
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeManagedWindowsLauncher(
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o755 });
  await chmodIfSupported(temporary, 0o755);
  await copyFile(temporary, path);
  await rm(temporary, { force: true });
}

async function restoreAutomaticLauncher(
  automatic: NonNullable<ManagedExternalCliLauncherV2["automaticLauncher"]>,
  shimPath: string,
): Promise<boolean> {
  const current = await symbolicLinkTarget(automatic.launcherPath);
  if (current?.resolved === resolve(shimPath)) {
    const temporary = `${automatic.launcherPath}.${process.pid}.${Date.now()}.tmp`;
    await symlink(automatic.originalTarget, temporary, "file");
    await rename(temporary, automatic.launcherPath);
    return true;
  }
  if (!(await pathExists(automatic.launcherPath))) {
    await mkdir(dirname(automatic.launcherPath), { recursive: true });
    await symlink(automatic.originalTarget, automatic.launcherPath, "file");
    return true;
  }
  return false;
}

async function restoreWindowsAutomaticLauncher(
  automatic: NonNullable<ManagedExternalCliLauncherV3["automaticLauncher"]>,
  launcherPath: string,
): Promise<boolean> {
  let restored = false;
  for (const entry of automatic.entries) {
    const expected = windowsAutomaticLauncherContent(entry.kind, launcherPath);
    const current = await readTextIfPresent(entry.launcherPath);
    const backupExists = await isRegularFile(entry.backupPath);
    if (current === expected) {
      if (!backupExists) {
        throw new BridgeError(
          "INVALID_CONFIG",
          `Cannot restore managed Windows Codex launcher without its backup: ${entry.launcherPath}`,
        );
      }
      await copyFile(entry.backupPath, entry.launcherPath);
      await rm(entry.backupPath, { force: true });
      restored = true;
      continue;
    }
    if (current === null && backupExists) {
      await rename(entry.backupPath, entry.launcherPath);
      restored = true;
      continue;
    }
    if (backupExists) {
      await rm(entry.backupPath, { force: true });
    }
  }
  return restored;
}

function windowsAutomaticLauncherMatches(
  automatic: NonNullable<ManagedExternalCliLauncherV3["automaticLauncher"]>,
  candidate: WindowsAutomaticCliLauncher,
): boolean {
  return (
    resolve(automatic.commandPath) === resolve(candidate.commandPath) &&
    automatic.entries.every((entry) =>
      candidate.entries.some(
        (candidateEntry) =>
          candidateEntry.kind === entry.kind &&
          resolve(candidateEntry.launcherPath) === resolve(entry.launcherPath),
      ),
    )
  );
}

async function validateWindowsAutomaticLauncherInstall(
  candidate: WindowsAutomaticCliLauncher,
): Promise<void> {
  for (const entry of candidate.entries) {
    if (!(await isRegularFile(entry.launcherPath))) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Windows npm Codex launcher is missing or not a regular file: ${entry.launcherPath}`,
      );
    }
    const backupPath = windowsAutomaticLauncherBackupPath(entry);
    if (await pathExists(backupPath)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Refusing to replace an unmanaged Windows Codex launcher backup: ${backupPath}`,
      );
    }
  }
}

async function installWindowsAutomaticLauncher(
  candidate: WindowsAutomaticCliLauncher,
  launcherPath: string,
): Promise<NonNullable<ManagedExternalCliLauncherV3["automaticLauncher"]>> {
  const entries: ManagedWindowsAutomaticLauncherEntry[] = candidate.entries.map(
    (entry) => ({
      ...entry,
      backupPath: windowsAutomaticLauncherBackupPath(entry),
    }),
  );
  await validateWindowsAutomaticLauncherInstall(candidate);

  const installed: ManagedWindowsAutomaticLauncherEntry[] = [];
  try {
    for (const entry of entries) {
      await rename(entry.launcherPath, entry.backupPath);
      installed.push(entry);
      await writeManagedWindowsLauncher(
        entry.launcherPath,
        windowsAutomaticLauncherContent(entry.kind, launcherPath),
      );
    }
  } catch (error) {
    for (const entry of installed.reverse()) {
      const current = await readTextIfPresent(entry.launcherPath);
      if (current === windowsAutomaticLauncherContent(entry.kind, launcherPath)) {
        await rm(entry.launcherPath, { force: true });
      }
      if (await pathExists(entry.backupPath)) {
        await rename(entry.backupPath, entry.launcherPath);
      }
    }
    throw error;
  }

  return {
    commandPath: candidate.commandPath,
    entries,
    kind: "windows-npm",
  };
}

async function reconcileWindowsAutomaticLauncher(
  candidate: WindowsAutomaticCliLauncher,
  previous: ManagedExternalCliLauncherV3 | null,
  launcherPath: string,
): Promise<{
  automatic: NonNullable<ManagedExternalCliLauncherV3["automaticLauncher"]>;
  result: ExternalCliLauncherReconcileResult;
}> {
  const previousAutomatic = previous?.automaticLauncher ?? null;
  if (!previous || !previousAutomatic) {
    return {
      automatic: await installWindowsAutomaticLauncher(candidate, launcherPath),
      result: "installed",
    };
  }
  if (!windowsAutomaticLauncherMatches(previousAutomatic, candidate)) {
    await restoreWindowsAutomaticLauncher(previousAutomatic, previous!.launcherPath);
    return {
      automatic: await installWindowsAutomaticLauncher(candidate, launcherPath),
      result: "updated",
    };
  }

  let changed = previous.launcherPath !== launcherPath;
  for (const entry of previousAutomatic.entries) {
    const current = await readTextIfPresent(entry.launcherPath);
    const previousContent = windowsAutomaticLauncherContent(
      entry.kind,
      previous.launcherPath,
    );
    const nextContent = windowsAutomaticLauncherContent(entry.kind, launcherPath);
    const backupExists = await isRegularFile(entry.backupPath);
    if (current === previousContent) {
      if (!backupExists) {
        throw new BridgeError(
          "INVALID_CONFIG",
          `Managed Windows Codex launcher backup is missing: ${entry.backupPath}`,
        );
      }
      if (current !== nextContent) {
        await writeManagedWindowsLauncher(entry.launcherPath, nextContent);
        changed = true;
      }
      continue;
    }
    if (current === null) {
      if (!backupExists) {
        throw new BridgeError(
          "INVALID_CONFIG",
          `Windows Codex launcher and backup are both missing: ${entry.launcherPath}`,
        );
      }
      await writeManagedWindowsLauncher(entry.launcherPath, nextContent);
      changed = true;
      continue;
    }
    if (!(await isRegularFile(entry.launcherPath))) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Refusing to replace a non-file Windows Codex launcher: ${entry.launcherPath}`,
      );
    }
    await copyFile(entry.launcherPath, entry.backupPath);
    await writeManagedWindowsLauncher(entry.launcherPath, nextContent);
    changed = true;
  }
  return {
    automatic: previousAutomatic,
    result: changed ? "updated" : "unchanged",
  };
}

export async function resolveExternalCliExecutable(
  command: string,
  options: ExternalCliLauncherOptions = {},
): Promise<ResolvedExternalCliExecutable> {
  if (!command) {
    throw new BridgeError("INVALID_CONFIG", "External Codex CLI executable is empty");
  }
  const environment = options.environment ?? process.env;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const integrationPath =
    options.integrationPath ?? bridgeExternalCliIntegrationPath(environment);
  const commandPath = await resolveCommandPath(command, environment, hostPlatform);
  const managed = await readManagedLauncher(integrationPath);
  const automaticLauncher =
    managed?.version === 2 ? managed.automaticLauncher : null;
  if (
    automaticLauncher?.launcherPath === commandPath &&
    (await symbolicLinkTarget(commandPath))?.resolved === resolve(managed!.shimPath)
  ) {
    return {
      automaticLauncherPath: commandPath,
      commandPath,
      executablePath: managed!.codexExecutable,
    };
  }
  const previousWindowsAutomatic = managedWindowsAutomaticLauncher(managed);
  const windowsAutomaticLauncher =
    hostPlatform === "win32"
      ? previousWindowsAutomatic &&
        previousWindowsAutomatic.entries.some(
          (entry) => resolve(entry.launcherPath) === resolve(commandPath),
        )
        ? windowsAutomaticCandidateFromManaged(previousWindowsAutomatic)
        : await detectWindowsAutomaticLauncher(commandPath)
      : undefined;
  if (previousWindowsAutomatic && windowsAutomaticLauncher) {
    const commandEntry = previousWindowsAutomatic.entries.find(
      (entry) => entry.kind === "cmd",
    );
    if (
      commandEntry &&
      resolve(commandEntry.launcherPath) === resolve(commandPath) &&
      (await readTextIfPresent(commandPath)) ===
        windowsAutomaticLauncherContent(commandEntry.kind, managed!.launcherPath)
    ) {
      if (!(await isRegularFile(commandEntry.backupPath))) {
        throw new BridgeError(
          "INVALID_CONFIG",
          `Managed Windows Codex launcher backup is missing: ${commandEntry.backupPath}`,
        );
      }
      return {
        commandPath,
        executablePath: commandEntry.backupPath,
        windowsAutomaticLauncher,
      };
    }
  }
  const executablePath = await realpath(commandPath);
  if (managed && resolve(executablePath) === resolve(managed.shimPath)) {
    throw new BridgeError(
      "INVALID_CONFIG",
      `External Codex CLI launcher resolves to the Bridge Shim without recovery metadata: ${commandPath}`,
    );
  }
  return {
    ...(hostPlatform !== "win32" && basename(commandPath) === "codex"
      ? { automaticLauncherPath: commandPath }
      : {}),
    commandPath,
    executablePath,
    ...(windowsAutomaticLauncher ? { windowsAutomaticLauncher } : {}),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeManagedLauncher(
  path: string,
  value: ManagedExternalCliLauncher,
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmodIfSupported(temporary, 0o600);
  await rename(temporary, path);
}

export async function reconcileExternalCliLauncher(
  codexExecutable: string,
  shimPath: string,
  options: ExternalCliLauncherOptions = {},
): Promise<{
  automaticLauncher: {
    launcherPath: string;
    result: ExternalCliLauncherReconcileResult;
  } | null;
  launcherPath: string;
  result: ExternalCliLauncherReconcileResult;
}> {
  if (!codexExecutable || !isAbsolute(shimPath)) {
    throw new BridgeError(
      "INVALID_CONFIG",
      "External CLI launcher requires a Codex command and an absolute Shim path",
    );
  }
  const environment = options.environment ?? process.env;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const integrationPath =
    options.integrationPath ?? bridgeExternalCliIntegrationPath(environment);
  const launcherPath =
    options.launcherPath ??
    externalCliLauncherPath(environment, hostPlatform, homeDirectory);
  const previous = await readManagedLauncher(integrationPath);
  const previousAutomatic =
    previous?.version === 2 ? previous.automaticLauncher : null;
  const previousWindows = previous?.version === 3 ? previous : null;
  const automaticLauncherPath = options.automaticLauncherPath;
  const windowsAutomaticLauncher = options.windowsAutomaticLauncher;
  let automaticCandidate: {
    launcherPath: string;
    needsUpdate: boolean;
    originalTarget: string;
    result: ExternalCliLauncherReconcileResult;
  } | null = null;
  if (hostPlatform !== "win32" && automaticLauncherPath) {
    if (
      !isAbsolute(automaticLauncherPath) ||
      resolve(automaticLauncherPath) === resolve(launcherPath)
    ) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Automatic external CLI launcher path must be absolute and distinct",
      );
    }
    const current = await symbolicLinkTarget(automaticLauncherPath);
    if (!current) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Refusing to replace a missing or non-symlink Codex launcher: ${automaticLauncherPath}`,
      );
    }
    const currentIsCurrentShim = current.resolved === resolve(shimPath);
    const currentIsManagedShim =
      currentIsCurrentShim ||
      (previousAutomatic?.launcherPath === automaticLauncherPath &&
        current.resolved === resolve(previous!.shimPath));
    if (
      currentIsManagedShim &&
      previousAutomatic?.launcherPath !== automaticLauncherPath
    ) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Refusing to adopt an unmanaged automatic Codex launcher: ${automaticLauncherPath}`,
      );
    }
    if (!currentIsManagedShim && current.resolved !== resolve(codexExecutable)) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Refusing to replace a Codex launcher that does not resolve to the configured CLI: ${automaticLauncherPath}`,
      );
    }
    automaticCandidate = {
      launcherPath: automaticLauncherPath,
      needsUpdate: !currentIsCurrentShim,
      originalTarget: currentIsManagedShim
        ? previousAutomatic!.originalTarget
        : current.raw,
      result: currentIsCurrentShim
        ? previous?.codexExecutable === codexExecutable
          ? "unchanged"
          : "updated"
        : previousAutomatic
          ? "updated"
          : "installed",
    };
  }
  if (
    windowsAutomaticLauncher &&
    !(
      previousWindows?.automaticLauncher &&
      windowsAutomaticLauncherMatches(
        previousWindows.automaticLauncher,
        windowsAutomaticLauncher,
      )
    )
  ) {
    await validateWindowsAutomaticLauncherInstall(windowsAutomaticLauncher);
  }
  await mkdir(dirname(launcherPath), { recursive: true });
  const exists = await pathExists(launcherPath);
  let result: ExternalCliLauncherReconcileResult = exists ? "updated" : "installed";

  if (hostPlatform === "win32") {
    if (exists && previous?.launcherPath !== launcherPath) {
      throw new BridgeError(
        "INVALID_CONFIG",
        `Refusing to replace an unmanaged external CLI launcher: ${launcherPath}`,
      );
    }
    const temporary = `${launcherPath}.${process.pid}.${Date.now()}.tmp`;
    await copyFile(shimPath, temporary);
    await copyFile(temporary, launcherPath);
    await rm(temporary, { force: true });
    if (
      previous?.launcherPath === launcherPath &&
      previous.shimPath === shimPath &&
      previous.codexExecutable === codexExecutable
    ) {
      result = "unchanged";
    }
  } else {
    let currentTarget: string | null = null;
    if (exists) {
      const metadata = await lstat(launcherPath);
      if (!metadata.isSymbolicLink()) {
        throw new BridgeError(
          "INVALID_CONFIG",
          `Refusing to replace an unmanaged external CLI launcher: ${launcherPath}`,
        );
      }
      currentTarget = resolve(dirname(launcherPath), await readlink(launcherPath));
      const managedTarget =
        previous?.launcherPath === launcherPath ? resolve(previous.shimPath) : null;
      if (currentTarget !== resolve(shimPath) && currentTarget !== managedTarget) {
        throw new BridgeError(
          "INVALID_CONFIG",
          `Refusing to replace an unmanaged external CLI launcher: ${launcherPath}`,
        );
      }
    }
    if (currentTarget === resolve(shimPath)) {
      result =
        previous?.codexExecutable === codexExecutable ? "unchanged" : "updated";
    } else {
      const temporary = `${launcherPath}.${process.pid}.${Date.now()}.tmp`;
      await symlink(shimPath, temporary, "file");
      await rename(temporary, launcherPath);
    }
  }

  let automaticLauncher: {
    launcherPath: string;
    result: ExternalCliLauncherReconcileResult;
  } | null = null;
  let managedAutomatic: ManagedExternalCliLauncherV2["automaticLauncher"] = null;
  let managedWindowsAutomatic: ManagedExternalCliLauncherV3["automaticLauncher"] = null;
  let managedCodexExecutable = codexExecutable;
  if (
    previousAutomatic &&
    previousAutomatic.launcherPath !== automaticLauncherPath
  ) {
    await restoreAutomaticLauncher(previousAutomatic, previous!.shimPath);
  }
  if (automaticCandidate) {
    if (automaticCandidate.needsUpdate) {
      await mkdir(dirname(automaticCandidate.launcherPath), { recursive: true });
      const temporary = `${automaticCandidate.launcherPath}.${process.pid}.${Date.now()}.tmp`;
      await symlink(shimPath, temporary, "file");
      await rename(temporary, automaticCandidate.launcherPath);
    }
    managedAutomatic = {
      launcherPath: automaticCandidate.launcherPath,
      originalTarget: automaticCandidate.originalTarget,
    };
    automaticLauncher = {
      launcherPath: automaticCandidate.launcherPath,
      result: automaticCandidate.result,
    };
  }

  if (previousWindows?.automaticLauncher && !windowsAutomaticLauncher) {
    await restoreWindowsAutomaticLauncher(
      previousWindows.automaticLauncher,
      previousWindows.launcherPath,
    );
  }
  if (windowsAutomaticLauncher) {
    const reconciled = await reconcileWindowsAutomaticLauncher(
      windowsAutomaticLauncher,
      previousWindows,
      launcherPath,
    );
    managedWindowsAutomatic = reconciled.automatic;
    const commandEntry = managedWindowsAutomatic.entries.find(
      (entry) => entry.kind === "cmd",
    );
    if (!commandEntry) {
      throw new BridgeError(
        "INVALID_CONFIG",
        "Managed Windows automatic CLI launcher has no command wrapper",
      );
    }
    managedCodexExecutable = commandEntry.backupPath;
    automaticLauncher = {
      launcherPath: managedWindowsAutomatic.commandPath,
      result: reconciled.result,
    };
  }

  await writeManagedLauncher(
    integrationPath,
    managedWindowsAutomatic
      ? {
          version: 3,
          codexExecutable: managedCodexExecutable,
          launcherPath,
          shimPath,
          automaticLauncher: managedWindowsAutomatic,
        }
      : {
          version: 2,
          codexExecutable,
          launcherPath,
          shimPath,
          automaticLauncher: managedAutomatic,
        },
  );
  return { automaticLauncher, launcherPath, result };
}

export async function removeExternalCliLauncher(
  options: ExternalCliLauncherOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const integrationPath =
    options.integrationPath ?? bridgeExternalCliIntegrationPath(environment);
  const managed = await readManagedLauncher(integrationPath);
  if (!managed) {
    return false;
  }
  let removed = false;
  if (managed.version === 2 && managed.automaticLauncher) {
    removed =
      (await restoreAutomaticLauncher(
        managed.automaticLauncher,
        managed.shimPath,
       )) || removed;
  }
  if (managed.version === 3 && managed.automaticLauncher) {
    removed =
      (await restoreWindowsAutomaticLauncher(
        managed.automaticLauncher,
        managed.launcherPath,
      )) || removed;
  }
  try {
    if (hostPlatform === "win32") {
      if (managed.launcherPath === (options.launcherPath ?? managed.launcherPath)) {
        await rm(managed.launcherPath, { force: true });
        removed = true;
      }
    } else {
      const metadata = await lstat(managed.launcherPath);
      if (
        metadata.isSymbolicLink() &&
        resolve(dirname(managed.launcherPath), await readlink(managed.launcherPath)) ===
          resolve(managed.shimPath)
      ) {
        await rm(managed.launcherPath, { force: true });
        removed = true;
      }
    }
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  await rm(integrationPath, { force: true });
  return removed;
}
