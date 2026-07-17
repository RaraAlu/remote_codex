import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AuditLog } from "../core/audit-log.js";
import { parseBridgeConfig } from "../core/config.js";
import { loadBridgeConfig, saveBridgeConfig } from "../core/config-store.js";
import { asBridgeError, BridgeError } from "../core/errors.js";
import {
  bridgeAuditPath,
  bridgeConfigPath,
  bridgeControlDir,
} from "../core/locations.js";
import { redact } from "../core/redaction.js";
import { OpenSshExecutor } from "../core/ssh-executor.js";
import { BridgeStateMachine } from "../core/state-machine.js";
import type { BridgeConfig, BridgeState, RemoteIdentity } from "../core/types.js";
import { codexExecutableCandidates } from "./codex-executable.js";
import { detectRemoteWorkspace } from "./remote-context.js";
import {
  OfficialSettingsManager,
  type OfficialSettingsStatus,
} from "./settings-manager.js";
import { repairCodexViewLocation } from "./view-location.js";

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
  #config: BridgeConfig | null = null;
  #executor: OpenSshExecutor | null = null;
  #initialization: Promise<void> | null = null;
  #autoSuppressed = false;
  #remoteIdentity: RemoteIdentity | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
    this.#output = vscode.window.createOutputChannel("Codex Remote Bridge", { log: true });
    this.#settings = new OfficialSettingsManager(context);
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
    ];
  }

  async initialize(): Promise<void> {
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
    if (this.#initialization) {
      return await this.#initialization;
    }

    const task = this.#configureCurrentRemote(false);
    this.#initialization = task;
    try {
      await task;
    } finally {
      if (this.#initialization === task) {
        this.#initialization = null;
      }
    }
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
      const shimPath = this.#context.asAbsolutePath("dist/codex-bridge-shim.cjs");
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
      this.#config = await loadBridgeConfig(bridgeConfigPath());
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
    this.#executor?.close();
    this.#executor = null;
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
    this.#output.dispose();
    this.#status.dispose();
  }

  #currentRemoteConfig(): BridgeConfig {
    const remote = detectRemoteWorkspace();
    const settings = vscode.workspace.getConfiguration("codexRemoteBridge");
    return parseBridgeConfig({
      version: 1,
      host: remote.host,
      workspaceRoot: remote.workspaceRoot,
      connectionMode: "openssh",
      localExecution: "deny",
      remoteHelper: "none",
      sshUser: settings.get<string | null>("sshUser"),
      sshPort: settings.get<number | null>("sshPort"),
      identityFile: settings.get<string | null>("identityFile"),
      codexExecutable: settings.get<string>("codexExecutable"),
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
    this.#executor?.close();
    this.#executor = new OpenSshExecutor(this.#config);
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

  async #diagnostics(): Promise<DiagnosticReport> {
    let config: BridgeConfig | null = this.#config;
    let configError: unknown = null;
    if (!config) {
      try {
        config = await loadBridgeConfig(bridgeConfigPath());
      } catch (error) {
        configError = asBridgeError(error, "INVALID_CONFIG").toPayload();
      }
    }

    let remoteIdentity = this.#remoteIdentity;
    let remoteCodexInstalled: boolean | null = null;
    let remoteError: unknown = configError;
    if (config) {
      const executor = this.#executor ?? new OpenSshExecutor(config);
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
    const shimPath = this.#context.asAbsolutePath("dist/codex-bridge-shim.cjs");
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
    for (const executable of new Set(codexExecutableCandidates(config.codexExecutable))) {
      const actual = await this.#readCodexVersion(executable);
      if (!actual) {
        continue;
      }
      detectedVersion ??= actual;
      if (!expected || actual === expected) {
        return {
          ...config,
          codexExecutable: executable,
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
