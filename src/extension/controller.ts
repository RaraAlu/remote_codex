import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AuditLog } from "../core/audit-log.js";
import { saveOfficialCodexRuntime } from "../core/codex-runtime-store.js";
import { defaultRemotePrimaryRoot, parseBridgeConfig } from "../core/config.js";
import { loadBridgeConfig, saveBridgeConfig } from "../core/config-store.js";
import { asBridgeError, BridgeError } from "../core/errors.js";
import {
  bridgeAuditPath,
  bridgeConfigPath,
  bridgeControlDir,
  bridgeSessionConfigPath,
  officialCodexRuntimePath,
} from "../core/locations.js";
import {
  OFFICIAL_CODEX_EXTENSION_ID,
  resolveOfficialCodexExecutable,
  type OfficialCodexRuntime,
} from "../core/official-codex.js";
import { redact } from "../core/redaction.js";
import { OpenSshExecutor } from "../core/ssh-executor.js";
import { resolveSshExecutable } from "../core/ssh-executable.js";
import { BridgeStateMachine } from "../core/state-machine.js";
import type { BridgeConfig, BridgeState, RemoteIdentity } from "../core/types.js";
import { VsCodeRemoteExecutor } from "../core/vscode-remote-executor.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_EXECUTOR_PING_COMMAND,
  REMOTE_EXECUTOR_VERSION,
  REMOTE_OUTPUT_COMMAND,
  isRemoteExecutorPing,
} from "../core/vscode-transport.js";
import { planAutomaticInitialization } from "./automatic-initialization.js";
import { detectRemoteWorkspace } from "./remote-context.js";
import { planRemoteExecutorInstall } from "./remote-executor-install.js";
import { installShimExecutable } from "./shim-executable.js";
import {
  reconcileExternalCliLauncher,
  reconcileExternalMcp,
  removeExternalCliLauncher,
  removeExternalMcp,
  resolveExternalCliExecutable,
  shouldReconcileExternalCliIntegration,
} from "./external-cli-integration.js";
import {
  OfficialSettingsManager,
  type OfficialSettingsStatus,
} from "./settings-manager.js";
import {
  LocalRootAuthority,
  type LocalRootDiagnostic,
} from "./local-root-authority.js";
import { ControllerWorkspaceDispatcher } from "./controller-workspace-dispatcher.js";
import { LocalWorkspaceExecutor } from "./local-workspace-executor.js";
import { repairCodexViewLocation } from "./view-location.js";
import { VsCodeTransportServer } from "./vscode-transport-server.js";
import {
  isWorkspaceResourceOperation,
  WorkspaceResourceController,
} from "./workspace-resource-controller.js";

const execFileAsync = promisify(execFile);

interface DiagnosticReport {
  generatedAt: string;
  bridge: {
    version: string;
    state: BridgeState;
    configPath: string;
    controlDir: string;
    workspaceSemantics: {
      controlDirectory: {
        path: string;
        role: "control";
        target: "local";
      };
      primaryRoot: BridgeConfig["roots"][number] | null;
    };
  };
  local: {
    hostname: string;
    machineId: string | null;
    extensionHostPid: number;
    extensionKind: string;
    vscodeRemoteName: string | null;
    codexExecutable: string | null;
    codexRuntimeSource: "official-extension" | null;
    codexVersion: string | null;
    codexExtensionVersion: string | null;
    shimPath: string;
    officialSettings: OfficialSettingsStatus;
    authorizedRoots: LocalRootDiagnostic[];
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
  readonly #localRoots: LocalRootAuthority;
  readonly #settings: OfficialSettingsManager;
  readonly #state = new BridgeStateMachine();
  readonly #status: vscode.StatusBarItem;
  readonly #sessionConfigPath: string | null;
  readonly #transport: VsCodeTransportServer;
  readonly #workspaceResources: WorkspaceResourceController;
  #config: BridgeConfig | null = null;
  #executor: OpenSshExecutor | null = null;
  #sessionConfig: BridgeConfig | null = null;
  #initialization: Promise<void> | null = null;
  #shutdown: Promise<void> | null = null;
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
    this.#localRoots = new LocalRootAuthority(context.globalState);
    this.#settings = new OfficialSettingsManager(context);
    const workspaceDispatcher = new ControllerWorkspaceDispatcher(
      () => this.#sessionConfig ?? this.#config,
      (rootId) => this.#localRoots.find(rootId),
    );
    this.#workspaceResources = new WorkspaceResourceController(
      () => this.#sessionConfig ?? this.#config,
      (rootId) => this.#localRoots.find(rootId),
    );
    this.#transport = new VsCodeTransportServer(
      () => this.#sessionConfig ?? this.#config,
      (request) =>
        isWorkspaceResourceOperation(request.operation)
          ? this.#workspaceResources.execute(request)
          : workspaceDispatcher.execute(request),
    );
    delete process.env.CODEX_BRIDGE_CODEX_EXECUTABLE;
    delete process.env.CODEX_BRIDGE_DEVELOPMENT_CODEX_EXECUTABLE;
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
      vscode.commands.registerCommand("codexRemoteBridge.authorizeLocalRoot", () =>
        this.authorizeLocalRoot(),
      ),
      vscode.commands.registerCommand("codexRemoteBridge.revokeLocalRoot", () =>
        this.revokeLocalRoot(),
      ),
      vscode.commands.registerCommand(
        "codexRemoteBridge.addRemoteFileContext",
        (resource?: vscode.Uri) => this.queueRemoteEditorContext("file", resource),
      ),
      vscode.commands.registerCommand(
        "codexRemoteBridge.addRemoteSelectionContext",
        () => this.queueRemoteEditorContext("selection"),
      ),
      vscode.commands.registerCommand("codexRemoteBridge.enableExternalCliMcp", () =>
        this.enableExternalCliMcp(),
      ),
      vscode.commands.registerCommand("codexRemoteBridge.disableExternalCliMcp", () =>
        this.disableExternalCliMcp(),
      ),
      vscode.commands.registerCommand("codexRemoteBridge.restoreSettings", () =>
        this.restoreOfficialSettings(),
      ),
      vscode.commands.registerCommand(REMOTE_OUTPUT_COMMAND, (event) =>
        this.#transport.handleOutput(event),
      ),
      this.#workspaceResources.register(),
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
    if (this.#state.state === "configuring") {
      this.#log("automatic initialization deferred while configuration is in progress");
      return;
    }

    const plan = planAutomaticInitialization({
      autoInitialize: vscode.workspace
        .getConfiguration("codexRemoteBridge")
        .get<boolean>("autoInitialize", true),
      autoSuppressed: this.#autoSuppressed,
      externalCliIntegration: shouldReconcileExternalCliIntegration(
        this.#context.globalState.get<boolean>("codexRemoteBridge.externalMcpEnabled"),
      ),
      managedExecutable: this.#settings.hasManagedExecutable(),
      remoteName: vscode.env.remoteName,
      workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    });
    if (!plan.refreshOfficialRuntime && !plan.reconcileExternalCli) {
      this.#log("automatic initialization disabled; bridge remains idle");
      return;
    }

    if (plan.refreshOfficialRuntime) {
      try {
        await this.#refreshOfficialCodexRuntime();
      } catch (error) {
        const bridgeError = asBridgeError(error, "PROTOCOL_MISMATCH");
        this.#log(`official Codex runtime validation failed: ${bridgeError.message}`);
        void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
        return;
      }
    }

    if (plan.repairManagedExecutable) {
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

    if (plan.reconcileExternalCli) {
      try {
        await this.#reconcileExternalCliMcp();
      } catch (error) {
        this.#log(`automatic external CLI integration skipped: ${String(error)}`);
      }
    }

    if (!plan.connectRemote) {
      this.#log("automatic Remote SSH initialization disabled; bridge remains idle");
      return;
    }
    await this.#configureCurrentRemote(false);
  }

  async configure(): Promise<void> {
    this.#autoSuppressed = false;
    await this.#configureCurrentRemote(true);
  }

  async authorizeLocalRoot(): Promise<void> {
    try {
      detectRemoteWorkspace();
      const selected = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(homedir()),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Authorize Folder",
        title: "Authorize a local secondary root for Codex Bridge",
      });
      const uri = selected?.[0];
      if (!uri) {
        return;
      }
      if (uri.scheme !== "file") {
        throw new BridgeError(
          "COMMAND_DENIED",
          "Only a local filesystem folder may be authorized",
        );
      }
      const root = await this.#localRoots.authorize(uri.fsPath);
      await this.#persistLocalRoots();
      await this.#audit.write({
        operation: "local_root.authorize",
        outcome: "succeeded",
        rootId: root.id,
        rootRole: root.role,
        rootPath: root.path,
        target: root.target,
      });
      const action = await vscode.window.showInformationMessage(
        `Codex Bridge authorized local root: ${root.displayName}`,
        "Reload Window",
      );
      if (action === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`local root authorization failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
    }
  }

  async revokeLocalRoot(): Promise<void> {
    try {
      const roots = this.#localRoots.roots();
      if (roots.length === 0) {
        void vscode.window.showInformationMessage(
          "Codex Bridge has no authorized local roots.",
        );
        return;
      }
      const selected = await vscode.window.showQuickPick(
        roots.map((root) => ({
          label: root.displayName,
          description: root.path,
          root,
        })),
        {
          placeHolder: "Select a local root authorization to revoke",
          title: "Revoke Codex Bridge Local Root",
        },
      );
      if (!selected) {
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        `Revoke Codex Bridge access to ${selected.root.path}?`,
        { modal: true },
        "Revoke",
      );
      if (confirmation !== "Revoke") {
        return;
      }
      if (!(await this.#localRoots.revoke(selected.root.id))) {
        throw new BridgeError("COMMAND_DENIED", "The local root authorization no longer exists");
      }
      await this.#persistLocalRoots();
      await this.#audit.write({
        operation: "local_root.revoke",
        outcome: "succeeded",
        rootId: selected.root.id,
        rootRole: selected.root.role,
        rootPath: selected.root.path,
        target: selected.root.target,
      });
      void vscode.window.showInformationMessage(
        `Codex Bridge revoked local root: ${selected.root.displayName}`,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`local root revocation failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
    }
  }

  async queueRemoteEditorContext(
    kind: "file" | "selection",
    resource?: vscode.Uri,
  ): Promise<void> {
    try {
      const context = await this.#workspaceResources.captureEditorContext(kind, resource);
      await this.#audit.write({
        operation: "editor_context.queue",
        outcome: "succeeded",
        hostId: context.hostId,
        workspaceRoot: context.workspaceRoot,
        rootId: context.rootId,
        rootRole: "primary",
        rootPath: context.workspaceRoot,
        target: context.target,
        details: {
          contentHash: context.contentHash,
          contextId: context.contextId,
          kind: context.kind,
          origin: context.origin,
          relativePath: context.relativePath,
          selection: context.selection ?? null,
          sizeBytes: context.sizeBytes,
          workspaceUri: context.workspaceUri,
        },
      });
      void vscode.window.showInformationMessage(
        `Codex Bridge queued remote ${kind} context for the next Codex turn: ${context.relativePath}`,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`remote editor context queue failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
    }
  }

  async #configureCurrentRemote(interactive: boolean): Promise<void> {
    if (this.#state.state !== "disabled") {
      this.#executor?.close();
      this.#executor = null;
      this.#state.transition("disabled");
    }
    this.#state.transition("configuring");
    try {
      const config = this.#currentRemoteConfig();
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
      this.#config = config;
      const settingsChanged = await this.#settings.configure(shimPath);
      if (settingsChanged) {
        if (interactive) {
          await vscode.workspace
            .getConfiguration("codexRemoteBridge")
            .update("autoInitialize", true, vscode.ConfigurationTarget.Global);
        }
        this.#log("official Codex settings updated; reloading the window once");
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        if (this.#state.state === "configuring") {
          this.#state.transition("disabled");
        }
        return;
      }

      this.#config = await this.#resolveCompatibleCodex(config);
      await saveBridgeConfig(bridgeConfigPath(), this.#config);
      await this.#saveWindowSession(this.#config);
      this.#state.transition("connecting");
      await this.#connect();
      if (interactive) {
        void vscode.window.showInformationMessage(
          `Codex Bridge ready: official extension Codex -> ${config.host}`,
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
      this.#config = await this.#resolveCompatibleCodex({
        ...storedConfig,
        sshExecutable: resolveSshExecutable(storedConfig.sshExecutable),
      });
      await saveBridgeConfig(bridgeConfigPath(), this.#config);
      await this.#saveWindowSession(this.#config);
      await this.#connect();
      void vscode.window.showInformationMessage(
        `Codex Bridge ready: official extension Codex -> ${this.#config.host}`,
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
    const executor = this.#executor;
    let remoteStop:
      | Awaited<ReturnType<VsCodeRemoteExecutor["stopWorkspace"]>>
      | undefined;
    let remoteStopError: BridgeError | undefined;
    if (executor instanceof VsCodeRemoteExecutor) {
      try {
        remoteStop = await executor.stopWorkspace();
      } catch (error) {
        remoteStopError = asBridgeError(error, "RESULT_UNKNOWN");
        this.#log(`remote workspace stop could not be confirmed: ${remoteStopError.message}`);
      }
    }
    executor?.close();
    this.#executor = null;
    await this.#transport.close();
    this.#remoteIdentity = null;
    if (this.#state.state !== "disabled") {
      this.#state.transition("disabled");
    }
    await this.#audit.write({
      operation: "bridge.stop",
      outcome: remoteStopError ? "unknown" : "succeeded",
      hostId: this.#config?.host,
      workspaceRoot: this.#config?.workspaceRoot,
      details: remoteStopError
        ? { error: remoteStopError.toPayload() }
        : { remoteStop: remoteStop ?? null },
    });
    if (remoteStopError) {
      throw remoteStopError;
    }
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

  async enableExternalCliMcp(): Promise<void> {
    try {
      const result = await this.#reconcileExternalCliMcp();
      await this.#context.globalState.update(
        "codexRemoteBridge.externalMcpEnabled",
        true,
      );
      void vscode.window.showInformationMessage(
        `Codex Bridge automatic CLI integration enabled. MCP: ${result.mcp}; live-thread launcher: ${result.launcher.result} at ${result.launcher.launcherPath}; plain codex: ${result.launcher.automaticLauncher?.result ?? "not managed"}. Restart an existing Codex CLI process once to join the active VS Code thread automatically.`,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "INVALID_CONFIG");
      this.#log(`external CLI MCP installation failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(
        `Codex Bridge could not configure the current Codex CLI: ${bridgeError.message}`,
      );
    }
  }

  async disableExternalCliMcp(): Promise<void> {
    try {
      const resolved = await resolveExternalCliExecutable(
        this.#externalCliExecutable(),
      );
      const removed = await removeExternalMcp(resolved.executablePath);
      const launcherRemoved = await removeExternalCliLauncher();
      await this.#context.globalState.update(
        "codexRemoteBridge.externalMcpEnabled",
        false,
      );
      void vscode.window.showInformationMessage(
        removed || launcherRemoved
          ? "Codex Bridge disabled automatic CLI integration and removed its managed files. Restart Codex CLI to unload MCP tools."
          : "Codex Bridge automatic CLI integration is disabled.",
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "INVALID_CONFIG");
      void vscode.window.showErrorMessage(
        `Codex Bridge could not remove the current Codex CLI integration: ${bridgeError.message}`,
      );
    }
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

  async #reconcileExternalCliMcp(): Promise<{
    launcher: Awaited<ReturnType<typeof reconcileExternalCliLauncher>>;
    mcp: "installed" | "updated" | "unchanged";
  }> {
    const shimPath = await installShimExecutable(this.#context);
    const resolved = await resolveExternalCliExecutable(
      this.#externalCliExecutable(),
    );
    const mcp = await reconcileExternalMcp(resolved.executablePath, shimPath);
    const launcher = await reconcileExternalCliLauncher(
      resolved.executablePath,
      shimPath,
      { automaticLauncherPath: resolved.automaticLauncherPath },
    );
    await this.#audit.write({
      operation: "external_cli.integration",
      outcome: "succeeded",
      details: {
        launcherPath: launcher.launcherPath,
        launcherResult: launcher.result,
        automaticLauncherPath: launcher.automaticLauncher?.launcherPath ?? null,
        automaticLauncherResult: launcher.automaticLauncher?.result ?? null,
        mcpResult: mcp,
      },
    });
    return { launcher, mcp };
  }

  #externalCliExecutable(): string {
    return vscode.workspace
      .getConfiguration("codexRemoteBridge")
      .get<string>("externalCliExecutable", "codex");
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) {
      return await this.#shutdown;
    }
    this.#shutdown = this.#shutdownOnce();
    return await this.#shutdown;
  }

  dispose(): void {
    void this.shutdown();
  }

  async #shutdownOnce(): Promise<void> {
    this.#executor?.close();
    this.#executor = null;
    try {
      await Promise.allSettled([
        this.#clearWindowSession(),
        this.#transport.close(),
      ]);
    } finally {
      this.#workspaceResources.dispose();
      this.#output.dispose();
      this.#status.dispose();
    }
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

  async #persistLocalRoots(): Promise<void> {
    const localRoots = this.#localRoots.roots();
    const activeRemoteWindow = vscode.env.remoteName === "ssh-remote";
    let baseConfig = this.#config;
    if (!baseConfig) {
      if (activeRemoteWindow) {
        baseConfig = this.#currentRemoteConfig();
      } else {
        try {
          baseConfig = await loadBridgeConfig(bridgeConfigPath());
        } catch {
          return;
        }
      }
    }
    const primaryRoot = baseConfig.roots.find(
      (root) => root.target === "remote" && root.role === "primary",
    );
    if (!primaryRoot) {
      throw new BridgeError("INVALID_CONFIG", "The remote primary root is missing");
    }
    const config = parseBridgeConfig({
      ...baseConfig,
      workspaceRoot: primaryRoot.path,
      roots: [primaryRoot, ...localRoots],
    });
    await saveBridgeConfig(bridgeConfigPath(), config);
    if (activeRemoteWindow || this.#config) {
      this.#config = config;
    }
    if (this.#sessionConfig) {
      await this.#saveWindowSession(config);
    }
  }

  #currentRemoteConfig(): BridgeConfig {
    const remote = detectRemoteWorkspace();
    const settings = vscode.workspace.getConfiguration("codexRemoteBridge");
    const connectionMode = settings.get<"vscode-remote" | "openssh">(
      "connectionMode",
      "vscode-remote",
    );
    return parseBridgeConfig({
      version: 2,
      host: remote.host,
      workspaceRoot: remote.workspaceRoot,
      roots: [
        defaultRemotePrimaryRoot(remote.workspaceRoot),
        ...this.#localRoots.roots(),
      ],
      connectionMode,
      localExecution: "deny",
      remoteHelper: connectionMode === "vscode-remote" ? "vscode-extension" : "none",
      sshUser: settings.get<string | null>("sshUser"),
      sshPort: settings.get<number | null>("sshPort"),
      identityFile: settings.get<string | null>("identityFile"),
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
    const markerKey = `codexRemoteBridge.executorInstall.${this.#config?.host ?? "remote"}`;
    if (await this.#waitForRemoteExecutorCommand()) {
      await this.#context.globalState.update(markerKey, undefined);
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
    const installPlan = planRemoteExecutorInstall(
      this.#context.globalState.get<unknown>(markerKey),
      digest,
    );
    if (!installPlan.allowed) {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        `Compatible Remote Executor is unavailable after ${installPlan.attempts} installation attempts; retry later or reinstall the Remote SSH window`,
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
      await this.#context.globalState.update(markerKey, installPlan.marker);
    } finally {
      await vscode.workspace.fs.delete(remoteVsix, { useTrash: false }).then(
        () => undefined,
        () => undefined,
      );
    }
    this.#log("installed the Remote Executor through the active VS Code Remote connection");
    if (await this.#waitForRemoteExecutorCommand()) {
      await this.#context.globalState.update(markerKey, undefined);
      this.#log("Remote Executor command became available without a window reload");
      return;
    }
    await this.#audit.write({
      operation: "executor.reload",
      outcome: "started",
      hostId: this.#config?.host,
      workspaceRoot: this.#config?.workspaceRoot,
      details: {
        automatic: true,
        executorVersion: REMOTE_EXECUTOR_VERSION,
        reason: "installed-executor-not-active",
      },
    });
    this.#log(
      `installed Remote Executor ${REMOTE_EXECUTOR_VERSION}; reloading the Remote SSH window automatically`,
    );
    void vscode.window.showInformationMessage(
      `Codex Bridge installed Remote Executor ${REMOTE_EXECUTOR_VERSION}. Reloading the Remote SSH window automatically.`,
    );
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    throw new BridgeError(
      "BRIDGE_NOT_READY",
      "Remote Executor installation triggered an automatic Remote SSH window reload",
    );
  }

  async #waitForRemoteExecutorCommand(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        const response = await vscode.commands.executeCommand<unknown>(REMOTE_EXECUTOR_PING_COMMAND);
        if (isRemoteExecutorPing(response)) {
          return true;
        }
      } catch {
        // The remote command is absent until the workspace extension is installed and registered.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    return false;
  }

  async #diagnostics(): Promise<DiagnosticReport> {
    let config: BridgeConfig | null = this.#config;
    let configError: unknown = null;
    let runtime: OfficialCodexRuntime | null = null;
    try {
      runtime = await this.#refreshOfficialCodexRuntime();
    } catch (error) {
      configError = asBridgeError(error, "PROTOCOL_MISMATCH").toPayload();
    }
    if (!config) {
      try {
        const storedConfig = await loadBridgeConfig(bridgeConfigPath());
        config = {
          ...storedConfig,
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
    const shimPath = await installShimExecutable(this.#context);
    return {
      generatedAt: new Date().toISOString(),
      bridge: {
        version: this.#context.extension.packageJSON.version as string,
        state: this.#state.state,
        configPath: bridgeConfigPath(),
        controlDir: bridgeControlDir(),
        workspaceSemantics: {
          controlDirectory: {
            path: bridgeControlDir(),
            role: "control",
            target: "local",
          },
          primaryRoot:
            config?.roots.find(
              (root) => root.target === "remote" && root.role === "primary",
            ) ?? null,
        },
      },
      local: {
        hostname: hostname(),
        machineId: await localMachineId(),
        extensionHostPid: process.pid,
        extensionKind:
          ownExtension?.extensionKind === vscode.ExtensionKind.UI ? "ui" : "workspace-or-unknown",
        vscodeRemoteName: vscode.env.remoteName ?? null,
        codexExecutable: runtime?.executable ?? null,
        codexRuntimeSource: runtime?.source ?? null,
        codexVersion: runtime?.codexVersion ?? null,
        codexExtensionVersion:
          (codexExtension?.packageJSON.version as string | undefined) ?? null,
        shimPath,
        officialSettings: this.#settings.status(shimPath),
        authorizedRoots: await this.#localRootDiagnostics(config),
      },
      remote: {
        identity: remoteIdentity,
        codexInstalled: remoteCodexInstalled,
        error: remoteError,
      },
      effectiveConfig: config,
    };
  }

  async #localRootDiagnostics(config: BridgeConfig | null): Promise<LocalRootDiagnostic[]> {
    const diagnostics = await this.#localRoots.diagnostics();
    if (!config) {
      return diagnostics;
    }
    return await Promise.all(
      diagnostics.map(async (diagnostic) => {
        if (!diagnostic.accessible) {
          return diagnostic;
        }
        try {
          const executor = new LocalWorkspaceExecutor(
            diagnostic.id,
            (rootId) => this.#localRoots.find(rootId),
            {
              commandTimeoutMs: config.commandTimeoutMs,
              maxOutputBytes: config.maxOutputBytes,
            },
          );
          await executor.canonicalPath(".");
          return diagnostic;
        } catch (error) {
          return {
            ...diagnostic,
            accessible: false,
            error: asBridgeError(error, "COMMAND_DENIED").message,
          };
        }
      }),
    );
  }

  #officialCodexInstallation(): {
    executable: string;
    extensionVersion: string | null;
  } {
    const extension = vscode.extensions.getExtension(OFFICIAL_CODEX_EXTENSION_ID);
    if (!extension) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "The official OpenAI Codex extension is not installed",
      );
    }
    const extensionVersion = extension.packageJSON.version;
    return {
      executable: resolveOfficialCodexExecutable(extension.extensionPath),
      extensionVersion:
        typeof extensionVersion === "string" && extensionVersion ? extensionVersion : null,
    };
  }

  async #resolveCompatibleCodex(config: BridgeConfig): Promise<BridgeConfig> {
    await this.#refreshOfficialCodexRuntime();
    return {
      ...config,
      sshExecutable: resolveSshExecutable(config.sshExecutable),
    };
  }

  async #refreshOfficialCodexRuntime(): Promise<OfficialCodexRuntime> {
    const installation = this.#officialCodexInstallation();
    const codexVersion = await this.#readCodexVersion(installation.executable);
    const runtime: OfficialCodexRuntime = {
      source: "official-extension",
      executable: installation.executable,
      extensionVersion: installation.extensionVersion,
      codexVersion,
    };
    await saveOfficialCodexRuntime(officialCodexRuntimePath(), runtime);
    return runtime;
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
