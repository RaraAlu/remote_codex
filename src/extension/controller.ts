import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AuditLog } from "../core/audit-log.js";
import { codexExecutableCandidates, resolveCodexExecutable } from "../core/codex-executable.js";
import { parseBridgeConfig } from "../core/config.js";
import { loadBridgeConfig, saveBridgeConfig } from "../core/config-store.js";
import { asBridgeError, BridgeError } from "../core/errors.js";
import {
  bridgeAuditPath,
  bridgeConfigPath,
  bridgeControlDir,
  bridgeSessionConfigPath,
} from "../core/locations.js";
import { redact } from "../core/redaction.js";
import { OpenSshExecutor } from "../core/ssh-executor.js";
import { resolveSshExecutable } from "../core/ssh-executable.js";
import { BridgeStateMachine } from "../core/state-machine.js";
import type { BridgeConfig, BridgeState, RemoteIdentity } from "../core/types.js";
import { VsCodeRemoteExecutor } from "../core/vscode-remote-executor.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_EXECUTOR_EXTENSION_ID,
  REMOTE_OUTPUT_COMMAND,
} from "../core/vscode-transport.js";
import { detectRemoteWorkspace } from "./remote-context.js";
import { installShimExecutable } from "./shim-executable.js";
import {
  OfficialSettingsManager,
  type OfficialSettingsStatus,
} from "./settings-manager.js";
import { repairCodexViewLocation } from "./view-location.js";
import { VsCodeTransportServer } from "./vscode-transport-server.js";

const execFileAsync = promisify(execFile);

interface DiagnosticReport {
  generatedAt: string;
  bridge: {
    version: string;
    state: BridgeState;
    configPath: string;
    controlDir: string;
  };
  local: {
    hostname: string;
    machineId: string | null;
    extensionHostPid: number;
    extensionKind: string;
    vscodeRemoteName: string | null;
    codexVersion: string | null;
    codexExtensionVersion: string | null;
    shimPath: string;
    officialSettings: OfficialSettingsStatus;
  };
  remote: {
    identity: RemoteIdentity | null;
    codexInstalled: boolean | null;
    error: unknown;
  };
  effectiveConfig: BridgeConfig | null;
}

function stateIcon(state: BridgeState): string {
  switch (state) {
    case "ready":
      return "$(remote-explorer)";
    case "busy":
      return "$(sync~spin)";
    case "degraded":
      return "$(warning)";
    case "incompatible":
      return "$(error)";
    case "connecting":
    case "configuring":
      return "$(loading~spin)";
    default:
      return "$(debug-disconnect)";
  }
}

async function localMachineId(): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("reg.exe", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      return stdout.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }
  try {
    return (await readFile("/etc/machine-id", "utf8")).trim();
  } catch {
    return null;
  }
}

export class BridgeController implements vscode.Disposable {
  readonly #audit = new AuditLog(bridgeAuditPath());
  readonly #context: vscode.ExtensionContext;
  readonly #output: vscode.OutputChannel;
  readonly #settings: OfficialSettingsManager;
  readonly #state = new BridgeStateMachine();
  readonly #status: vscode.StatusBarItem;
  readonly #sessionConfigPath: string | null;
  readonly #transport: VsCodeTransportServer;
  #config: BridgeConfig | null = null;
  #executor: OpenSshExecutor | null = null;
  #sessionConfig: BridgeConfig | null = null;
  #initialization: Promise<void> | null = null;
  #autoSuppressed = false;
  #remoteIdentity: RemoteIdentity | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
    this.#sessionConfigPath =
      vscode.env.remoteName === "ssh-remote" ? bridgeSessionConfigPath(process.pid) : null;
    if (this.#sessionConfigPath) {
      process.env.CODEX_BRIDGE_SESSION_CONFIG = this.#sessionConfigPath;
    } else {
      delete process.env.CODEX_BRIDGE_SESSION_CONFIG;
    }
    this.#output = vscode.window.createOutputChannel("Codex Remote Bridge", { log: true });
    this.#settings = new OfficialSettingsManager(context);
    this.#transport = new VsCodeTransportServer(() => this.#sessionConfig ?? this.#config);
    const officialCodex = vscode.extensions.getExtension("openai.chatgpt");
    const bundledCodex = officialCodex
      ? join(
          officialCodex.extensionPath,
          "bin",
          process.platform === "win32" ? "windows-x86_64" : "linux-x86_64",
          process.platform === "win32" ? "codex.exe" : "codex",
        )
      : undefined;
    process.env.CODEX_BRIDGE_CODEX_EXECUTABLE ??= resolveCodexExecutable("codex", {
      additionalCandidates: bundledCodex ? [bundledCodex] : [],
    });
    this.#status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
    this.#status.command = "codexRemoteBridge.diagnostics";
    this.#status.tooltip = "Codex Remote Bridge diagnostics";
    this.#status.show();
    this.#state.onChange((current, previous) => {
      this.#log(`state ${previous} -> ${current}`);
      this.#renderStatus();
      void this.#audit.write({
        operation: "bridge.state",
        outcome: "succeeded",
        state: current,
        hostId: this.#config?.host,
        workspaceRoot: this.#config?.workspaceRoot,
        details: { previous },
      });
    });
    this.#renderStatus();
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand("codexRemoteBridge.configure", () => this.configure()),
      vscode.commands.registerCommand("codexRemoteBridge.start", () => this.start()),
      vscode.commands.registerCommand("codexRemoteBridge.stop", () => this.stop()),
      vscode.commands.registerCommand("codexRemoteBridge.diagnostics", () => this.showDiagnostics()),
      vscode.commands.registerCommand("codexRemoteBridge.showAuditLog", () => this.showAuditLog()),
      vscode.commands.registerCommand("codexRemoteBridge.restoreSettings", () =>
        this.restoreOfficialSettings(),
      ),
      vscode.commands.registerCommand(REMOTE_OUTPUT_COMMAND, (event) =>
        this.#transport.handleOutput(event),
      ),
    ];
  }

  async initialize(): Promise<void> {
    if (this.#initialization) {
      return await this.#initialization;
    }

    const task = this.#initializeOnce();
    this.#initialization = task;
    try {
      await task;
    } finally {
      if (this.#initialization === task) {
        this.#initialization = null;
      }
    }
  }

  async #initializeOnce(): Promise<void> {
    if (this.#settings.hasManagedExecutable()) {
      try {
        const shimPath = await installShimExecutable(this.#context);
        if (await this.#settings.repairManagedExecutable(shimPath)) {
          this.#log(`migrated the managed Codex launcher to ${shimPath}; reloading the window`);
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
          return;
        }
      } catch (error) {
        const bridgeError = asBridgeError(error, "INVALID_CONFIG");
        this.#log(`managed launcher repair failed: ${bridgeError.message}`);
        void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
        return;
      }
    }

    if (
      this.#autoSuppressed ||
      vscode.env.remoteName !== "ssh-remote" ||
      !vscode.workspace
        .getConfiguration("codexRemoteBridge")
        .get<boolean>("autoInitialize", true) ||
      !vscode.workspace.workspaceFolders?.length
    ) {
      return;
    }
    await this.#configureCurrentRemote(false);
  }

  async configure(): Promise<void> {
    this.#autoSuppressed = false;
    await this.#configureCurrentRemote(true);
  }

  async #configureCurrentRemote(interactive: boolean): Promise<void> {
    if (this.#state.state !== "disabled") {
      this.#executor?.close();
      this.#executor = null;
      this.#state.transition("disabled");
    }
    this.#state.transition("configuring");
    try {
      const config = await this.#resolveCompatibleCodex(this.#currentRemoteConfig());
      process.env.CODEX_BRIDGE_CODEX_EXECUTABLE = config.codexExecutable;
      const shimPath = await installShimExecutable(this.#context);
      if (interactive) {
        const confirmation = await vscode.window.showWarningMessage(
          [
            "Codex Bridge will configure:",
            `Remote target: ${config.host}:${config.workspaceRoot}`,
            `SSH endpoint: ${config.sshUser ? `${config.sshUser}@` : ""}${config.host}${config.sshPort ? `:${config.sshPort}` : ""}`,
            `chatgpt.cliExecutable: ${shimPath}`,
            "remote.extensionKind.openai.chatgpt: [ui]",
            "Previous global values will be backed up for restoration.",
          ].join("\n"),
          { modal: true },
          "Configure",
        );
        if (confirmation !== "Configure") {
          this.#state.transition("disabled");
          return;
        }
      }

      await saveBridgeConfig(bridgeConfigPath(), config);
      await this.#saveWindowSession(config);
      this.#config = config;
      const settingsChanged = await this.#settings.configure(shimPath);
      if (settingsChanged) {
        this.#log("official Codex settings updated; reloading the window once");
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        if (this.#state.state === "configuring") {
          this.#state.transition("disabled");
        }
        return;
      }

      this.#state.transition("connecting");
      await this.#connect();
      if (interactive) {
        void vscode.window.showInformationMessage(
          `Codex Bridge ready: local Codex -> ${config.host}`,
        );
      }
    } catch (error) {
      const bridgeError = asBridgeError(error, "INVALID_CONFIG");
      this.#log(
        `${interactive ? "configure" : "automatic initialization"} failed: ${bridgeError.message}`,
      );
      this.#transitionFailure(bridgeError);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
    }
  }

  async start(): Promise<void> {
    this.#autoSuppressed = false;
    if (!["disabled", "disconnected", "degraded", "incompatible"].includes(this.#state.state)) {
      if (this.#state.state === "ready") {
        return;
      }
      throw new BridgeError("BRIDGE_NOT_READY", `Cannot start from ${this.#state.state}`);
    }
    this.#state.transition("connecting");
    try {
      const storedConfig = await loadBridgeConfig(bridgeConfigPath());
      this.#config = {
        ...storedConfig,
        codexExecutable: resolveCodexExecutable(storedConfig.codexExecutable),
        sshExecutable: resolveSshExecutable(storedConfig.sshExecutable),
      };
      process.env.CODEX_BRIDGE_CODEX_EXECUTABLE = this.#config.codexExecutable;
      await this.#saveWindowSession(this.#config);
      await this.#verifyCodexVersion(this.#config);
      await this.#connect();
      void vscode.window.showInformationMessage(
        `Codex Bridge ready: local Codex -> ${this.#config.host}`,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "SSH_DISCONNECTED");
      this.#log(`start failed: ${bridgeError.message}`);
      this.#transitionFailure(bridgeError);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
    }
  }

  async stop(): Promise<void> {
    this.#autoSuppressed = true;
    await this.#clearWindowSession();
    this.#executor?.close();
    this.#executor = null;
    await this.#transport.close();
    this.#remoteIdentity = null;
    if (this.#state.state !== "disabled") {
      this.#state.transition("disabled");
    }
    await this.#audit.write({
      operation: "bridge.stop",
      outcome: "succeeded",
      hostId: this.#config?.host,
      workspaceRoot: this.#config?.workspaceRoot,
    });
  }

  async showDiagnostics(): Promise<void> {
    const report = await this.#diagnostics();
    const document = await vscode.workspace.openTextDocument({
      content: `${JSON.stringify(redact(report), null, 2)}\n`,
      language: "json",
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async showAuditLog(): Promise<void> {
    await this.#audit.write({
      operation: "audit.open",
      outcome: "succeeded",
    });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(bridgeAuditPath()));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async restoreOfficialSettings(): Promise<void> {
    await this.stop();
    await vscode.workspace
      .getConfiguration("codexRemoteBridge")
      .update("autoInitialize", false, vscode.ConfigurationTarget.Global);
    const restored = await this.#settings.restore();
    if (restored) {
      void vscode.window.showInformationMessage(
        "Codex Bridge restored the previous official Codex and Remote SSH settings. Reload VS Code.",
      );
    } else {
      void vscode.window.showInformationMessage("Codex Bridge has no saved settings to restore.");
    }
  }

  dispose(): void {
    this.#executor?.close();
    void this.#clearWindowSession().catch(() => undefined);
    this.#transport.dispose();
    this.#output.dispose();
    this.#status.dispose();
  }

  async #saveWindowSession(config: BridgeConfig): Promise<void> {
    this.#sessionConfig = await this.#prepareSessionConfig(config);
    if (!this.#sessionConfigPath) {
      return;
    }
    process.env.CODEX_BRIDGE_SESSION_CONFIG = this.#sessionConfigPath;
    await saveBridgeConfig(this.#sessionConfigPath, this.#sessionConfig);
  }

  async #prepareSessionConfig(config: BridgeConfig): Promise<BridgeConfig> {
    if (config.connectionMode !== "vscode-remote") {
      return config;
    }
    const vscodeTransport = await this.#transport.start();
    return parseBridgeConfig({ ...config, vscodeTransport });
  }

  async #clearWindowSession(): Promise<void> {
    if (!this.#sessionConfigPath) {
      return;
    }
    if (process.env.CODEX_BRIDGE_SESSION_CONFIG === this.#sessionConfigPath) {
      delete process.env.CODEX_BRIDGE_SESSION_CONFIG;
    }
    this.#sessionConfig = null;
    await rm(this.#sessionConfigPath, { force: true });
  }

  #currentRemoteConfig(): BridgeConfig {
    const remote = detectRemoteWorkspace();
    const settings = vscode.workspace.getConfiguration("codexRemoteBridge");
    const connectionMode = settings.get<"vscode-remote" | "openssh">(
      "connectionMode",
      "vscode-remote",
    );
    return parseBridgeConfig({
      version: 1,
      host: remote.host,
      workspaceRoot: remote.workspaceRoot,
      connectionMode,
      localExecution: "deny",
      remoteHelper: connectionMode === "vscode-remote" ? "vscode-extension" : "none",
      sshUser: settings.get<string | null>("sshUser"),
      sshPort: settings.get<number | null>("sshPort"),
      identityFile: settings.get<string | null>("identityFile"),
      codexExecutable: settings.get<string>("codexExecutable"),
      sshExecutable: resolveSshExecutable(settings.get<string>("sshExecutable", "ssh")),
      remoteMcpRouting: settings.get<"auto" | "local">("remoteMcpRouting", "auto"),
      remoteMcpAccess: settings.get<"enabled" | "all">("remoteMcpAccess", "enabled"),
      commandTimeoutMs: settings.get<number>("commandTimeoutMs"),
      maxOutputBytes: settings.get<number>("maxOutputBytes"),
      maxParallelReads: 8,
      maxParallelWrites: 1,
      connectTimeoutSeconds: settings.get<number>("connectTimeoutSeconds"),
    });
  }

  async #connect(): Promise<void> {
    if (!this.#config) {
      throw new BridgeError("INVALID_CONFIG", "Bridge is not configured");
    }
    if (this.#config.connectionMode === "vscode-remote") {
      await this.#ensureRemoteExecutor();
    }
    this.#executor?.close();
    const sessionConfig = this.#sessionConfig ?? (await this.#prepareSessionConfig(this.#config));
    this.#sessionConfig = sessionConfig;
    this.#executor =
      sessionConfig.connectionMode === "vscode-remote"
        ? new VsCodeRemoteExecutor(sessionConfig)
        : new OpenSshExecutor(sessionConfig);
    this.#remoteIdentity = await this.#executor.probe();
    if (this.#remoteIdentity.workspaceRoot !== this.#config.workspaceRoot) {
      this.#executor.close();
      this.#executor = null;
      throw new BridgeError(
        "PATH_OUTSIDE_ROOT",
        "Remote workspace contains symlinks or aliases; configure its canonical path",
        {
          configured: this.#config.workspaceRoot,
          canonical: this.#remoteIdentity.workspaceRoot,
        },
      );
    }
    this.#state.transition("ready");
    await this.#audit.write({
      operation: "bridge.connect",
      outcome: "succeeded",
      state: "ready",
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      workspaceRoot: this.#config.workspaceRoot,
      remoteCwd: this.#remoteIdentity.workspaceRoot,
      details: {
        connectionMode: this.#config.connectionMode,
        hostname: this.#remoteIdentity.hostname,
        machineId: this.#remoteIdentity.machineId,
      },
    });
    try {
      const repair = await repairCodexViewLocation(vscode.commands, this.#context.workspaceState);
      if (repair === "repaired") {
        this.#log("restored the Codex view to its default secondary sidebar location");
      }
    } catch (error) {
      this.#log(`Codex view location repair skipped: ${String(error)}`);
    }
  }

  async #ensureRemoteExecutor(): Promise<void> {
    if (await this.#waitForRemoteExecutorCommand()) {
      return;
    }

    const source = this.#context.asAbsolutePath("dist/codex-remote-bridge-executor.vsix");
    let packageBytes: Buffer;
    try {
      packageBytes = await readFile(source);
    } catch (error) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "The bundled Remote Executor VSIX is missing from the controller package",
        undefined,
        { cause: error },
      );
    }
    const digest = createHash("sha256").update(packageBytes).digest("hex");
    const markerKey = `codexRemoteBridge.executorInstall.${this.#config?.host ?? "remote"}`;
    if (this.#context.globalState.get<string>(markerKey) === digest) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "Remote Executor was installed but its command is still unavailable; reload or reinstall the Remote SSH window",
      );
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "vscode-remote") {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "Remote Executor installation requires an active Remote SSH workspace",
      );
    }
    const remoteVsix = folder.uri.with({
      path: `/tmp/codex-remote-bridge-executor-${digest.slice(0, 12)}.vsix`,
    });
    await vscode.workspace.fs.writeFile(remoteVsix, packageBytes);
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        remoteVsix,
        { donotSync: true },
      );
      await this.#context.globalState.update(markerKey, digest);
    } finally {
      await vscode.workspace.fs.delete(remoteVsix, { useTrash: false }).then(
        () => undefined,
        () => undefined,
      );
    }
    this.#log("installed the Remote Executor through the active VS Code Remote connection");
    void vscode.window.showInformationMessage(
      "Codex Bridge installed its Remote Executor. Reloading the Remote SSH window once.",
    );
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    throw new BridgeError(
      "BRIDGE_NOT_READY",
      "Remote Executor installation requires the in-progress window reload",
    );
  }

  async #waitForRemoteExecutorCommand(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const installed = vscode.extensions.getExtension(REMOTE_EXECUTOR_EXTENSION_ID);
      if (installed) {
        try {
          await installed.activate();
        } catch {
          // A local copy of a workspace extension cannot activate for the remote window.
        }
      }
      if ((await vscode.commands.getCommands(false)).includes(REMOTE_EXECUTOR_COMMAND)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return false;
  }

  async #diagnostics(): Promise<DiagnosticReport> {
    let config: BridgeConfig | null = this.#config;
    let configError: unknown = null;
    if (!config) {
      try {
        const storedConfig = await loadBridgeConfig(bridgeConfigPath());
        config = {
          ...storedConfig,
          codexExecutable: resolveCodexExecutable(storedConfig.codexExecutable),
          sshExecutable: resolveSshExecutable(storedConfig.sshExecutable),
        };
      } catch (error) {
        configError = asBridgeError(error, "INVALID_CONFIG").toPayload();
      }
    }

    let remoteIdentity = this.#remoteIdentity;
    let remoteCodexInstalled: boolean | null = null;
    let remoteError: unknown = configError;
    if (config) {
      const sessionConfig =
        this.#sessionConfig ?? (await this.#prepareSessionConfig(config));
      this.#sessionConfig = sessionConfig;
      const executor =
        this.#executor ??
        (sessionConfig.connectionMode === "vscode-remote"
          ? new VsCodeRemoteExecutor(sessionConfig)
          : new OpenSshExecutor(sessionConfig));
      try {
        remoteIdentity = remoteIdentity ?? (await executor.probe());
        const remoteCodex = await executor.execute([
          "sh",
          "-c",
          "command -v codex >/dev/null 2>&1",
        ]);
        remoteCodexInstalled = remoteCodex.exitCode === 0;
      } catch (error) {
        remoteError = asBridgeError(error, "SSH_DISCONNECTED").toPayload();
      } finally {
        if (executor !== this.#executor) {
          executor.close();
        }
      }
    }

    const codexExtension = vscode.extensions.getExtension("openai.chatgpt");
    const ownExtension = vscode.extensions.getExtension("zkbot.codex-vscode-remote-bridge");
    const codexVersion = config ? await this.#readCodexVersion(config.codexExecutable) : null;
    const shimPath = await installShimExecutable(this.#context);
    return {
      generatedAt: new Date().toISOString(),
      bridge: {
        version: this.#context.extension.packageJSON.version as string,
        state: this.#state.state,
        configPath: bridgeConfigPath(),
        controlDir: bridgeControlDir(),
      },
      local: {
        hostname: hostname(),
        machineId: await localMachineId(),
        extensionHostPid: process.pid,
        extensionKind:
          ownExtension?.extensionKind === vscode.ExtensionKind.UI ? "ui" : "workspace-or-unknown",
        vscodeRemoteName: vscode.env.remoteName ?? null,
        codexVersion,
        codexExtensionVersion:
          (codexExtension?.packageJSON.version as string | undefined) ?? null,
        shimPath,
        officialSettings: this.#settings.status(shimPath),
      },
      remote: {
        identity: remoteIdentity,
        codexInstalled: remoteCodexInstalled,
        error: remoteError,
      },
      effectiveConfig: config,
    };
  }

  async #verifyCodexVersion(config: BridgeConfig): Promise<void> {
    const actual = await this.#readCodexVersion(config.codexExecutable);
    const expected = this.#context.extension.packageJSON.codexAppServerVersion as
      | string
      | undefined;
    if (!actual) {
      throw new BridgeError("PROTOCOL_MISMATCH", "Unable to determine local Codex version");
    }
    if (expected && actual !== expected) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        `Codex ${actual} is incompatible with generated bridge protocol ${expected}`,
      );
    }
  }

  async #resolveCompatibleCodex(config: BridgeConfig): Promise<BridgeConfig> {
    const expected = this.#context.extension.packageJSON.codexAppServerVersion as
      | string
      | undefined;
    let detectedVersion: string | null = null;
    const officialCodex = vscode.extensions.getExtension("openai.chatgpt");
    const bundledCodex = officialCodex
      ? join(
          officialCodex.extensionPath,
          "bin",
          process.platform === "win32" ? "windows-x86_64" : "linux-x86_64",
          process.platform === "win32" ? "codex.exe" : "codex",
        )
      : undefined;
    for (const executable of new Set(
      codexExecutableCandidates(
        config.codexExecutable,
        undefined,
        undefined,
        undefined,
        undefined,
        bundledCodex ? [bundledCodex] : [],
      ),
    )) {
      const actual = await this.#readCodexVersion(executable);
      if (!actual) {
        continue;
      }
      detectedVersion ??= actual;
      if (!expected || actual === expected) {
        return {
          ...config,
          codexExecutable: executable,
          sshExecutable: resolveSshExecutable(config.sshExecutable),
        };
      }
    }
    if (detectedVersion && expected) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        `Codex ${detectedVersion} is incompatible with generated bridge protocol ${expected}`,
      );
    }
    throw new BridgeError("PROTOCOL_MISMATCH", "Unable to determine local Codex version");
  }

  async #readCodexVersion(executable: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(executable, ["--version"], {
        timeout: 10_000,
        windowsHide: true,
      });
      return stdout.trim().replace(/^codex-cli\s+/, "");
    } catch {
      return null;
    }
  }

  #transitionFailure(error: BridgeError): void {
    const next = error.code === "PROTOCOL_MISMATCH" ? "incompatible" : "disconnected";
    if (this.#state.state !== next) {
      this.#state.transition(next);
    }
  }

  #renderStatus(): void {
    const target = this.#config?.host ?? "unconfigured";
    this.#status.text = `${stateIcon(this.#state.state)} Codex: local -> ${target} (${this.#state.state})`;
    this.#status.backgroundColor =
      this.#state.state === "incompatible" || this.#state.state === "disconnected"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : this.#state.state === "degraded"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
  }

  #log(message: string): void {
    this.#output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}
