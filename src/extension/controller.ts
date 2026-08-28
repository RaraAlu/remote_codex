import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AuditLog } from "../core/audit-log.js";
import { saveOfficialCodexRuntime } from "../core/codex-runtime-store.js";
import { defaultRemotePrimaryRoot, parseBridgeConfig } from "../core/config.js";
import { loadBridgeConfig, saveBridgeConfig } from "../core/config-store.js";
import { asBridgeError, BridgeError } from "../core/errors.js";
import {
  clearLocalWorkspaceContext,
  localWorkspaceContextPath,
  publishLocalWorkspaceRoot,
  saveLocalWorkspaceContext,
} from "../core/local-workspace-context.js";
import {
  bridgeAuditPath,
  bridgeConfigPath,
  bridgeControlDir,
  bridgeRemoteControlDir,
  bridgeSessionConfigPath,
  bridgeShimRuntimeStatusPath,
  codexInlineMentionCompatibilityDir,
  officialCodexRuntimePath,
  officialExtensionCompatibilityDir,
  workbenchDropCompatibilityDir,
} from "../core/locations.js";
import {
  OFFICIAL_CODEX_EXTENSION_ID,
  resolveOfficialCodexExecutable,
  type OfficialCodexRuntime,
} from "../core/official-codex.js";
import { redact } from "../core/redaction.js";
import { OpenSshExecutor } from "../core/ssh-executor.js";
import { resolveSshExecutable } from "../core/ssh-executable.js";
import {
  EMPTY_SHIM_RUNTIME_HEALTH,
  loadShimRuntimeStatus,
  shimRuntimeHealth,
  type ShimRuntimeHealth,
} from "../core/shim-runtime-status.js";
import { BridgeStateMachine } from "../core/state-machine.js";
import type {
  BridgeConfig,
  BridgeState,
  ConversationResourceConfig,
  RemoteIdentity,
} from "../core/types.js";
import { VsCodeRemoteExecutor } from "../core/vscode-remote-executor.js";
import {
  REMOTE_EXECUTOR_COMMAND,
  REMOTE_EXECUTOR_PING_COMMAND,
  REMOTE_EXECUTOR_VERSION,
  REMOTE_OUTPUT_COMMAND,
  type RemoteExecutorPing,
  isRemoteExecutorPing,
} from "../core/vscode-transport.js";
import { planAutomaticInitialization } from "./automatic-initialization.js";
import {
  appServerSessionBootstrapFingerprint,
  shouldReloadForAppServerSession,
} from "./app-server-session-bootstrap.js";
import { detectRemoteWorkspace } from "./remote-context.js";
import {
  planRemoteExecutorInstall,
  shouldRefreshRemoteExecutor,
} from "./remote-executor-install.js";
import { waitForRemoteExecutorReadiness } from "./remote-executor-readiness.js";
import {
  installOfficialShimLauncher,
  installShimExecutable,
} from "./shim-executable.js";
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
  reconcileOfficialExtensionCompatibility,
  restoreOfficialExtensionCompatibility,
  type OfficialExtensionCompatibilityResult,
} from "./official-extension-compatibility.js";
import { DropConsentState } from "./drop-consent-state.js";
import { ControllerWorkspaceDispatcher } from "./controller-workspace-dispatcher.js";
import { ConversationResourceAuthority } from "./conversation-resource-authority.js";
import { fullLocalAccessRoot } from "./full-local-access-root.js";
import { LocalWorkspaceExecutor } from "./local-workspace-executor.js";
import {
  attachDroppedResourcesToCodex,
  parseWorkbenchDropPayload,
} from "./codex-context-drop.js";
import {
  enableCodexInlineMentionCompatibility,
  inspectCodexInlineMentionCompatibility,
  restoreCodexInlineMentionCompatibility,
  type CodexInlineMentionCompatibilityResult,
} from "./codex-inline-mention-compatibility.js";
import { repairCodexViewLocation } from "./view-location.js";
import {
  enableWorkbenchDropCompatibility,
  inspectWorkbenchDropCompatibility,
  replaceWorkbenchAssetWithPkexec,
  restoreWorkbenchDropCompatibility,
  workbenchDropTargetNeedsElevation,
  type WorkbenchAssetReplacer,
  type WorkbenchDropCompatibilityResult,
} from "./workbench-drop-compatibility.js";
import { VsCodeTransportServer } from "./vscode-transport-server.js";
import {
  isWorkspaceResourceOperation,
  WorkspaceResourceController,
} from "./workspace-resource-controller.js";

const execFileAsync = promisify(execFile);
const WORKBENCH_DROP_ONBOARDING_KEY =
  "codexRemoteBridge.workbenchDropOnboardingFingerprint.v2";
const APP_SERVER_SESSION_BOOTSTRAP_KEY =
  "codexRemoteBridge.appServerSessionBootstrapFingerprint.v1";

interface DiagnosticReport {
  generatedAt: string;
  bridge: {
    version: string;
    state: BridgeState;
    configPath: string;
    controlDir: string;
    startup: {
      phase: ConnectionPhase;
      phaseStartedAt: string | null;
      remoteExecutorAttempts: number | null;
      remoteExecutorWaitMs: number | null;
      remoteExecutorWaitSlow: boolean;
    };
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
    nodeExecutable: string | null;
    shimStarted: boolean;
    shimPid: number | null;
    shimLastExitCode: number | null;
    appServerInitialized: boolean;
    appServerLastError: string | null;
    officialSettings: OfficialSettingsStatus;
    officialExtensionCompatibility: OfficialExtensionCompatibilityResult | null;
    codexInlineMentionCompatibility: CodexInlineMentionCompatibilityResult | null;
    workbenchDropCompatibility: WorkbenchDropCompatibilityResult | null;
    automaticDropAuthorizationEnabled: boolean;
    fullLocalAccess: {
      root: BridgeConfig["roots"][number];
      accessible: boolean;
      error: string | null;
    };
    conversationResources: {
      resourceCount: number;
      threadCount: number;
    };
  };
  remote: {
    identity: RemoteIdentity | null;
    codexInstalled: boolean | null;
    error: unknown;
  };
  effectiveConfig: BridgeConfig | null;
}

type ConnectionPhase =
  | "idle"
  | "waiting-remote-extension-host"
  | "probing-remote-workspace"
  | "waiting-codex-app-server";

interface RemoteExecutorReadinessMetrics {
  attempts: number;
  elapsedMs: number;
  slow: boolean;
}

const CONNECTION_PHASE_LABELS: Record<ConnectionPhase, string> = {
  idle: "",
  "waiting-remote-extension-host": "waiting for Remote Extension Host",
  "probing-remote-workspace": "probing remote workspace",
  "waiting-codex-app-server": "waiting for Codex app-server",
};

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

function isReloadCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { message?: unknown; name?: unknown };
  return (
    candidate.name === "Canceled" ||
    candidate.name === "CancellationError" ||
    candidate.message === "Canceled"
  );
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
  readonly #conversationResources: ConversationResourceAuthority;
  readonly #output: vscode.OutputChannel;
  readonly #dropConsent: DropConsentState;
  readonly #settings: OfficialSettingsManager;
  readonly #state = new BridgeStateMachine();
  readonly #status: vscode.StatusBarItem;
  readonly #sessionConfigPath: string | null;
  readonly #localWorkspaceContextPath = localWorkspaceContextPath(process.pid);
  readonly #transport: VsCodeTransportServer;
  readonly #workspaceResources: WorkspaceResourceController;
  #config: BridgeConfig | null = null;
  #executor: OpenSshExecutor | null = null;
  #sessionConfig: BridgeConfig | null = null;
  #initialization: Promise<void> | null = null;
  #dropOnboarding: Promise<void> | null = null;
  #shutdown: Promise<void> | null = null;
  #reloadRequested = false;
  #autoSuppressed = false;
  #remoteIdentity: RemoteIdentity | null = null;
  #shimRuntimeHealth: ShimRuntimeHealth = { ...EMPTY_SHIM_RUNTIME_HEALTH };
  #shimRuntimeMonitor: NodeJS.Timeout | null = null;
  #shimRuntimeMonitorGeneration = 0;
  #officialExtensionCompatibility: OfficialExtensionCompatibilityResult | null = null;
  #connectionPhase: ConnectionPhase = "idle";
  #connectionPhaseStartedAtMs: number | null = null;
  #remoteExecutorReadiness: RemoteExecutorReadinessMetrics | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
    publishLocalWorkspaceRoot(
      process.env,
      vscode.env.remoteName,
      vscode.workspace.workspaceFolders,
    );
    this.#sessionConfigPath =
      vscode.env.remoteName === "ssh-remote" ? bridgeSessionConfigPath(process.pid) : null;
    if (this.#sessionConfigPath) {
      process.env.CODEX_BRIDGE_SESSION_CONFIG = this.#sessionConfigPath;
    } else {
      delete process.env.CODEX_BRIDGE_SESSION_CONFIG;
    }
    this.#output = vscode.window.createOutputChannel("Codex Remote Bridge", { log: true });
    this.#conversationResources = new ConversationResourceAuthority(context.globalState);
    this.#dropConsent = new DropConsentState(context.globalState);
    this.#settings = new OfficialSettingsManager(context);
    const workspaceDispatcher = new ControllerWorkspaceDispatcher(
      () => this.#sessionConfig ?? this.#config,
      (threadId, rootId) =>
        this.#conversationResources.find(threadId, rootId) ??
        (rootId === fullLocalAccessRoot().id ? fullLocalAccessRoot() : undefined),
    );
    this.#workspaceResources = new WorkspaceResourceController(
      () => this.#sessionConfig ?? this.#config,
      (threadId, rootId) =>
        this.#conversationResources.find(threadId, rootId) ??
        (rootId === fullLocalAccessRoot().id ? fullLocalAccessRoot() : undefined),
    );
    this.#transport = new VsCodeTransportServer(
      () => this.#sessionConfig ?? this.#config,
      (request) =>
        request.operation === "deleteConversationResources"
          ? this.#deleteConversationResources(request.params)
          : request.operation === "resolveConversationResources"
          ? this.#resolveConversationResources(request.params)
          : isWorkspaceResourceOperation(request.operation)
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
      vscode.commands.registerCommand("codexRemoteBridge.enableWorkbenchDrop", () =>
        this.enableWorkbenchDrop(),
      ),
      vscode.commands.registerCommand("codexRemoteBridge.disableWorkbenchDrop", () =>
        this.disableWorkbenchDrop(),
      ),
      vscode.commands.registerCommand("codexRemoteBridge.acceptWorkbenchDrop", (payload) =>
        this.addWorkbenchCodexContext(payload),
      ),
      vscode.commands.registerCommand(REMOTE_OUTPUT_COMMAND, (event) =>
        this.#transport.handleOutput(event),
      ),
      this.#workspaceResources.register(),
    ];
  }

  async initialize(): Promise<void> {
    const localWorkspaceRoot = publishLocalWorkspaceRoot(
      process.env,
      vscode.env.remoteName,
      vscode.workspace.workspaceFolders,
    );
    await saveLocalWorkspaceContext(this.#localWorkspaceContextPath, localWorkspaceRoot);
    if (this.#initialization) {
      return await this.#initialization;
    }

    const task = (async () => {
      if (await this.#initializeOnce()) {
        await this.offerWorkbenchDropOnboarding();
      }
    })();
    this.#initialization = task;
    try {
      await task;
    } finally {
      if (this.#initialization === task) {
        this.#initialization = null;
      }
    }
  }

  async #initializeOnce(): Promise<boolean> {
    if (this.#state.state === "configuring") {
      this.#log("automatic initialization deferred while configuration is in progress");
      return false;
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
    if (plan.repairManagedExecutable) {
      try {
        const shimPath = await installOfficialShimLauncher(this.#context);
        const repair = await this.#settings.repairManagedExecutable(shimPath);
        if (repair.reloadRequired) {
          this.#log(`migrated the managed Codex launcher to ${shimPath}; reloading the window`);
          await this.#reloadWindow();
          return false;
        }
        if (repair.changed) {
          this.#log(
            `migrated the managed Codex launcher to ${shimPath}; continuing without another window reload`,
          );
        }
      } catch (error) {
        const bridgeError = asBridgeError(error, "INVALID_CONFIG");
        this.#log(`managed launcher repair failed: ${bridgeError.message}`);
        void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
        return false;
      }
    }

    if (!plan.refreshOfficialRuntime && !plan.reconcileExternalCli) {
      this.#log("automatic initialization disabled; bridge remains idle");
      return true;
    }

    if (plan.refreshOfficialRuntime) {
      try {
        await this.#refreshOfficialCodexRuntime();
      } catch (error) {
        const bridgeError = asBridgeError(error, "PROTOCOL_MISMATCH");
        this.#log(`official Codex runtime validation failed: ${bridgeError.message}`);
        void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
        return false;
      }
      try {
        if (await this.#reconcileOfficialExtensionCompatibility()) {
          return false;
        }
      } catch (error) {
        this.#log(`official Codex compatibility reconciliation skipped: ${String(error)}`);
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
      return true;
    }
    await this.#configureCurrentRemote(false);
    return !this.#reloadRequested;
  }

  async configure(): Promise<void> {
    this.#autoSuppressed = false;
    await this.#configureCurrentRemote(true);
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

  async addDroppedCodexContext(
    resources: readonly vscode.Uri[],
  ): Promise<Awaited<ReturnType<typeof attachDroppedResourcesToCodex>>> {
    try {
      const result = await attachDroppedResourcesToCodex(resources, {
        log: (message) => this.logCodexContextDrop(message),
      });
      if (result.attachedCount === 0) {
        throw new BridgeError(
          "COMMAND_DENIED",
          result.firstFailure ?? "No dropped resource could be added to Codex",
        );
      }
      await this.#audit.write({
        operation: "codex_context.drop",
        outcome: "succeeded",
        hostId: this.#config?.host,
        workspaceRoot: this.#config?.workspaceRoot,
        details: {
          attachedCount: result.attachedCount,
          directoryCount: result.directoryCount,
          duplicateCount: result.duplicateCount,
          failedCount: result.failedCount,
          fileCount: result.fileCount,
          insertionMode: "inline-mention",
          localCount: result.localCount,
          remoteCount: result.remoteCount,
        },
      });
      if (result.failedCount > 0) {
        void vscode.window.showWarningMessage(
          `Codex Bridge added ${result.attachedCount} context item(s); ${result.failedCount} failed: ${result.firstFailure ?? "unknown error"}`,
        );
      } else {
        vscode.window.setStatusBarMessage(
          `Codex Bridge added ${result.attachedCount} context item(s)`,
          3_000,
        );
      }
      return result;
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`Codex context drop failed: ${bridgeError.message}`);
      await this.#audit.write({
        operation: "codex_context.drop",
        outcome: "failed",
        hostId: this.#config?.host,
        workspaceRoot: this.#config?.workspaceRoot,
        details: { error: bridgeError.message },
      });
      throw bridgeError;
    }
  }

  async addWorkbenchCodexContext(payload: unknown): Promise<void> {
    try {
      this.logCodexContextDrop("phase.workbench.drop.begin");
      const parsed = parseWorkbenchDropPayload(
        payload,
        (message) => this.logCodexContextDrop(message),
      );
      const localResourcesReady = await this.#prepareDroppedLocalResources(
        parsed.resources,
      );
      if (!localResourcesReady) {
        this.logCodexContextDrop(
          `phase.workbench.drop.deferred source=${JSON.stringify(parsed.source)} reason="local-resource-authorization"`,
        );
        return;
      }
      const result = await this.addDroppedCodexContext(parsed.resources);
      this.logCodexContextDrop(
        `phase.workbench.drop.complete source=${JSON.stringify(parsed.source)} insertionMode="inline-mention" resourceCount=${parsed.resources.length} attachedCount=${result.attachedCount}`,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.logCodexContextDrop(
        `phase.workbench.drop.failure error=${JSON.stringify(bridgeError.message)}`,
      );
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
      throw bridgeError;
    }
  }

  async #prepareDroppedLocalResources(
    resources: readonly vscode.Uri[],
  ): Promise<boolean> {
    if (vscode.env.remoteName !== "ssh-remote") {
      return true;
    }
    const localPaths = resources
      .filter((resource) => resource.scheme === "file")
      .map((resource) => resource.fsPath);
    if (localPaths.length === 0) {
      return true;
    }
    const connectionMode =
      (this.#sessionConfig ?? this.#config)?.connectionMode ??
      vscode.workspace
        .getConfiguration("codexRemoteBridge")
        .get<"vscode-remote" | "openssh">("connectionMode", "vscode-remote");
    if (connectionMode !== "vscode-remote") {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Local conversation resources require the VS Code Remote transport",
      );
    }
    const staged = await this.#conversationResources.stageDropped(localPaths);
    for (const resource of staged) {
      await this.#audit.write({
        operation: "conversation_resource.stage_drop",
        outcome: "succeeded",
        rootPath: resource.path,
        target: "local",
        details: {
          kind: resource.kind,
          authorizationMode: "drop-surface-consent",
        },
      });
    }
    vscode.window.setStatusBarMessage(
      `Codex Bridge staged ${staged.length} local resource(s) for the current conversation`,
      3_000,
    );
    return true;
  }

  async #resolveConversationResources(
    params: Record<string, unknown>,
  ): Promise<ConversationResourceConfig[]> {
    const threadId = params.threadId;
    const mentionPaths = params.mentionPaths;
    if (
      typeof threadId !== "string" ||
      !Array.isArray(mentionPaths) ||
      !mentionPaths.every((path) => typeof path === "string")
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Conversation resource resolution requires a thread ID and mention paths",
      );
    }
    const claim = await this.#conversationResources.claim(threadId, mentionPaths);
    for (const resource of claim.claimed) {
      await this.#audit.write({
        operation: "conversation_resource.claim",
        outcome: "succeeded",
        rootId: resource.id,
        rootRole: resource.role,
        rootPath: resource.path,
        target: resource.target,
        details: {
          kind: resource.kind,
          threadId,
        },
      });
    }
    return claim.resources;
  }

  async #deleteConversationResources(
    params: Record<string, unknown>,
  ): Promise<{ deleted: boolean }> {
    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "Conversation resource deletion requires a thread ID",
      );
    }
    const deleted = await this.#conversationResources.deleteThread(threadId);
    await this.#audit.write({
      operation: "conversation_resource.delete_thread",
      outcome: "succeeded",
      details: { deleted, threadId },
    });
    return { deleted };
  }

  logCodexContextDrop(message: string): void {
    this.#log(`[context-drop] ${message}`);
  }

  async offerWorkbenchDropOnboarding(): Promise<void> {
    if (this.#dropOnboarding) {
      return await this.#dropOnboarding;
    }
    const task = this.#offerWorkbenchDropOnboardingOnce();
    this.#dropOnboarding = task;
    try {
      await task;
    } finally {
      if (this.#dropOnboarding === task) {
        this.#dropOnboarding = null;
      }
    }
  }

  async #offerWorkbenchDropOnboardingOnce(): Promise<void> {
    let installation: {
      extensionPath: string;
      extensionVersion: string | null;
    };
    try {
      installation = this.#officialCodexExtensionIdentity();
    } catch (error) {
      this.#log(`native Codex drop onboarding deferred: ${String(error)}`);
      return;
    }
    const fingerprint = this.#workbenchDropOnboardingFingerprint(installation);
    if (
      this.#context.globalState.get<string>(WORKBENCH_DROP_ONBOARDING_KEY) ===
      fingerprint
    ) {
      return;
    }

    const [workbench, inlineMention] = await Promise.all([
      inspectWorkbenchDropCompatibility({
        appRoot: vscode.env.appRoot,
        stateDirectory: workbenchDropCompatibilityDir(),
      }),
      inspectCodexInlineMentionCompatibility({
        extensionPath: installation.extensionPath,
        extensionVersion: installation.extensionVersion,
        stateDirectory: codexInlineMentionCompatibilityDir(),
      }),
    ]).catch((error) => {
      this.#log(`native Codex drop onboarding inspection failed: ${String(error)}`);
      return [] as const;
    });
    if (!workbench || !inlineMention) {
      return;
    }

    const patchableStatuses = new Set(["disabled", "already-restored", "already-patched"]);
    if (
      !patchableStatuses.has(workbench.status) ||
      !patchableStatuses.has(inlineMention.status)
    ) {
      this.#log(
        `native Codex drop onboarding skipped: workbench=${workbench.status} inlineMention=${inlineMention.status}`,
      );
      return;
    }

    await this.#context.globalState.update(WORKBENCH_DROP_ONBOARDING_KEY, fingerprint);
    if (
      workbench.status === "already-patched" &&
      inlineMention.status === "already-patched" &&
      this.#dropConsent.enabled()
    ) {
      this.#log("native Codex drop onboarding: compatibility layer already enabled");
      return;
    }
    this.#log("native Codex drop onboarding: requesting user consent and required file access");
    await this.enableWorkbenchDrop();
  }

  async enableWorkbenchDrop(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      [
        "This compatibility layer modifies the installed VS Code Workbench and official Codex Webview JavaScript assets.",
        "VS Code Explorer and system file manager drops will be inserted as native @ mentions at the current composer cursor.",
        "In Remote SSH windows, every local file or folder you explicitly drop will automatically authorize its containing folder; paths you have not dropped remain inaccessible.",
        "Codex Bridge keeps SHA-256 verified backups and refuses to overwrite later changes.",
        "A VS Code or official Codex update may remove the patches and require a new compatibility check.",
      ].join("\n"),
      { modal: true },
      "Enable",
    );
    await this.#rememberWorkbenchDropOnboardingDecision();
    if (confirmation !== "Enable") {
      return;
    }
    const automaticAuthorizationWasEnabled =
      this.#dropConsent.enabled();
    try {
      await this.#dropConsent.setEnabled(true);
      await this.#audit.write({
        operation: "local_root.automatic_drop_authorization.enable",
        outcome: "succeeded",
        details: { scope: "explicitly-dropped-local-resources" },
      });
    } catch (error) {
      if (!automaticAuthorizationWasEnabled) {
        try {
          await this.#dropConsent.setEnabled(false);
        } catch (rollbackError) {
          this.#log(
            `automatic local drop authorization state rollback failed: ${String(rollbackError)}`,
          );
        }
      }
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`automatic local drop authorization enable failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
      return;
    }
    let inlineMentionChanged = false;
    let compatibilityChanged = false;
    try {
      const installation = this.#officialCodexExtensionIdentity();
      const inlineMention = await enableCodexInlineMentionCompatibility({
        extensionPath: installation.extensionPath,
        extensionVersion: installation.extensionVersion,
        stateDirectory: codexInlineMentionCompatibilityDir(),
      });
      await this.#recordCodexInlineMentionCompatibility("enable", inlineMention);
      if (["conflict", "unavailable", "unsupported"].includes(inlineMention.status)) {
        throw new BridgeError(
          "COMMAND_DENIED",
          inlineMention.detail ??
            `Codex inline mention compatibility is ${inlineMention.status}`,
        );
      }
      inlineMentionChanged = inlineMention.changed;

      const workbench = await enableWorkbenchDropCompatibility({
        appRoot: vscode.env.appRoot,
        stateDirectory: workbenchDropCompatibilityDir(),
        replaceTarget: await this.#workbenchDropReplacer(),
      });
      await this.#recordWorkbenchDropCompatibility("enable", workbench);
      if (["conflict", "unavailable", "unsupported"].includes(workbench.status)) {
        throw new BridgeError(
          "COMMAND_DENIED",
          workbench.detail ?? `Workbench drop compatibility is ${workbench.status}`,
        );
      }
      compatibilityChanged = workbench.changed || inlineMention.changed;
    } catch (error) {
      if (!automaticAuthorizationWasEnabled) {
        try {
          await this.#dropConsent.setEnabled(false);
          await this.#audit.write({
            operation: "local_root.automatic_drop_authorization.rollback",
            outcome: "succeeded",
            details: { scope: "explicitly-dropped-local-resources" },
          });
        } catch (rollbackError) {
          this.#log(
            `automatic local drop authorization rollback failed: ${String(rollbackError)}`,
          );
        }
      }
      if (inlineMentionChanged) {
        try {
          const installation = this.#officialCodexExtensionIdentity();
          const restored = await restoreCodexInlineMentionCompatibility({
            extensionPath: installation.extensionPath,
            extensionVersion: installation.extensionVersion,
            stateDirectory: codexInlineMentionCompatibilityDir(),
          });
          await this.#recordCodexInlineMentionCompatibility("rollback", restored);
        } catch (rollbackError) {
          this.#log(
            `Codex inline mention compatibility rollback failed: ${String(rollbackError)}`,
          );
        }
      }
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`Workbench drop compatibility enable failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
      return;
    }

    if (!compatibilityChanged) {
      void vscode.window.showInformationMessage(
        "The native Codex drop surface is already enabled.",
      );
      return;
    }
    this.#log("native Codex drop compatibility enabled; reloading the window automatically");
    void vscode.window.showInformationMessage(
      "Codex Bridge enabled cursor-positioned @ mention drops. Reloading VS Code automatically.",
    );
    try {
      await this.#reloadWindow();
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`automatic reload after native Codex drop enable failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(
        `Codex Bridge enabled native drops, but could not reload VS Code automatically: ${bridgeError.message}`,
      );
    }
  }

  async disableWorkbenchDrop(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      "Restore the exact VS Code Workbench and official Codex Webview assets saved before drop compatibility was enabled?",
      { modal: true },
      "Disable",
    );
    if (confirmation !== "Disable") {
      return;
    }
    await this.#rememberWorkbenchDropOnboardingDecision();
    try {
      await this.#dropConsent.setEnabled(false);
      await this.#audit.write({
        operation: "local_root.automatic_drop_authorization.disable",
        outcome: "succeeded",
        details: { scope: "explicitly-dropped-local-resources" },
      });
      const workbench = await restoreWorkbenchDropCompatibility({
        appRoot: vscode.env.appRoot,
        stateDirectory: workbenchDropCompatibilityDir(),
        replaceTarget: await this.#workbenchDropReplacer(),
      });
      await this.#recordWorkbenchDropCompatibility("restore", workbench);
      const installation = this.#officialCodexExtensionIdentity();
      const inlineMention = await restoreCodexInlineMentionCompatibility({
        extensionPath: installation.extensionPath,
        extensionVersion: installation.extensionVersion,
        stateDirectory: codexInlineMentionCompatibilityDir(),
      });
      await this.#recordCodexInlineMentionCompatibility("restore", inlineMention);
      const failed = [workbench, inlineMention].find((result) =>
        ["conflict", "unavailable", "unsupported"].includes(result.status),
      );
      if (failed) {
        throw new BridgeError(
          "COMMAND_DENIED",
          failed.detail ?? `Codex drop compatibility is ${failed.status}`,
        );
      }
      void vscode.window.showInformationMessage(
        workbench.changed || inlineMention.changed
          ? "Codex Bridge restored the original VS Code and Codex assets. Reload VS Code manually to finish."
          : "The native Codex drop surface is not enabled.",
      );
    } catch (error) {
      const bridgeError = asBridgeError(error, "COMMAND_DENIED");
      this.#log(`Workbench drop compatibility restore failed: ${bridgeError.message}`);
      void vscode.window.showErrorMessage(`Codex Bridge: ${bridgeError.message}`);
    }
  }

  async #workbenchDropReplacer(): Promise<WorkbenchAssetReplacer | undefined> {
    if (!(await workbenchDropTargetNeedsElevation(vscode.env.appRoot))) {
      return undefined;
    }
    if (process.platform !== "linux") {
      throw new BridgeError(
        "COMMAND_DENIED",
        "The current VS Code installation needs elevated file access, which this platform does not yet support",
      );
    }
    return replaceWorkbenchAssetWithPkexec;
  }

  async #rememberWorkbenchDropOnboardingDecision(): Promise<void> {
    try {
      const installation = this.#officialCodexExtensionIdentity();
      await this.#context.globalState.update(
        WORKBENCH_DROP_ONBOARDING_KEY,
        this.#workbenchDropOnboardingFingerprint(installation),
      );
    } catch (error) {
      this.#log(`native Codex drop onboarding decision could not be recorded: ${String(error)}`);
    }
  }

  #workbenchDropOnboardingFingerprint(installation: {
    extensionPath: string;
    extensionVersion: string | null;
  }): string {
    return createHash("sha256")
      .update(
        [
          vscode.env.appRoot,
          vscode.version,
          installation.extensionPath,
          installation.extensionVersion ?? "unknown",
        ].join("\0"),
      )
      .digest("hex");
  }

  async #recordWorkbenchDropCompatibility(
    action: "enable" | "restore",
    result: WorkbenchDropCompatibilityResult,
  ): Promise<void> {
    this.#log(
      `Workbench drop compatibility ${action}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`,
    );
    await this.#audit.write({
      operation: `workbench_drop.${action}`,
      outcome: result.status === "conflict" || result.status === "unsupported" ? "failed" : "succeeded",
      details: { ...result },
    });
  }

  async #recordCodexInlineMentionCompatibility(
    action: "enable" | "restore" | "rollback",
    result: CodexInlineMentionCompatibilityResult,
  ): Promise<void> {
    this.#log(
      `Codex inline mention compatibility ${action}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`,
    );
    await this.#audit.write({
      operation: `codex_inline_mention.${action}`,
      outcome:
        result.status === "conflict" || result.status === "unsupported"
          ? "failed"
          : "succeeded",
      details: { ...result },
    });
  }

  async #configureCurrentRemote(interactive: boolean): Promise<void> {
    this.#stopShimRuntimeMonitor();
    this.#shimRuntimeHealth = { ...EMPTY_SHIM_RUNTIME_HEALTH };
    this.#setConnectionPhase("idle");
    this.#remoteExecutorReadiness = null;
    if (this.#state.state !== "disabled") {
      this.#executor?.close();
      this.#executor = null;
      this.#state.transition("disabled");
    }
    this.#state.transition("configuring");
    try {
      const config = this.#currentRemoteConfig();
      const shimPath = await installOfficialShimLauncher(this.#context);
      if (interactive) {
        const confirmation = await vscode.window.showWarningMessage(
          [
            "Codex Bridge will configure:",
            `Remote target: ${config.host}:${config.workspaceRoot}`,
            `SSH endpoint: ${config.sshUser ? `${config.sshUser}@` : ""}${config.host}${config.sshPort ? `:${config.sshPort}` : ""}`,
            `chatgpt.cliExecutable: ${shimPath}`,
            "remote.extensionKind.openai.chatgpt: [ui]",
            "remote.extensionKind.GitHub.copilot-chat: [ui]",
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
        await this.#reloadWindow();
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
      if (await this.#reloadForMissingAppServerSession(this.#config)) {
        return;
      }
      if (interactive) {
        void vscode.window.showInformationMessage(
          this.#state.state === "ready"
            ? `Codex Bridge ready: official extension Codex -> ${config.host}`
            : `Codex Bridge remote transport ready; waiting for official Codex app-server -> ${config.host}`,
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

  async #reloadWindow(): Promise<void> {
    this.#reloadRequested = true;
    try {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } catch (error) {
      if (!isReloadCancellation(error)) {
        throw error;
      }
      this.#log("window reload request canceled this Extension Host activation as expected");
    }
  }

  async #reloadForMissingAppServerSession(config: BridgeConfig): Promise<boolean> {
    const fingerprint = appServerSessionBootstrapFingerprint({
      bridgeVersion: this.#context.extension.packageJSON.version as string,
      host: config.host,
      vscodeVersion: vscode.version,
      workspaceRoot: config.workspaceRoot,
    });
    const previous = this.#context.workspaceState.get<string>(
      APP_SERVER_SESSION_BOOTSTRAP_KEY,
    );
    if (
      !shouldReloadForAppServerSession(
        this.#shimRuntimeHealth.shimStarted,
        previous,
        fingerprint,
      )
    ) {
      if (!this.#shimRuntimeHealth.shimStarted && previous === fingerprint) {
        this.#log(
          "official Codex app-server is still detached after the one-time session bootstrap reload",
        );
      }
      return false;
    }
    await this.#context.workspaceState.update(
      APP_SERVER_SESSION_BOOTSTRAP_KEY,
      fingerprint,
    );
    await this.#audit.write({
      operation: "app_server.session_bootstrap_reload",
      outcome: "succeeded",
      hostId: config.host,
      workspaceRoot: config.workspaceRoot,
      details: {
        appServerInitialized: this.#shimRuntimeHealth.appServerInitialized,
        shimStarted: this.#shimRuntimeHealth.shimStarted,
      },
    });
    this.#log(
      "official Codex started before the remote window session was published; reloading once",
    );
    await this.#reloadWindow();
    return true;
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
      this.#config = await this.#resolveCompatibleCodex(
        this.#withFullLocalAccess({
          ...storedConfig,
          sshExecutable: resolveSshExecutable(storedConfig.sshExecutable),
        }),
      );
      await saveBridgeConfig(bridgeConfigPath(), this.#config);
      await this.#saveWindowSession(this.#config);
      await this.#connect();
      if (await this.#reloadForMissingAppServerSession(this.#config)) {
        return;
      }
      void vscode.window.showInformationMessage(
        this.#state.state === "ready"
          ? `Codex Bridge ready: official extension Codex -> ${this.#config.host}`
          : `Codex Bridge remote transport ready; waiting for official Codex app-server -> ${this.#config.host}`,
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
    this.#stopShimRuntimeMonitor();
    this.#shimRuntimeHealth = { ...EMPTY_SHIM_RUNTIME_HEALTH };
    this.#setConnectionPhase("idle");
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
    let compatibility: OfficialExtensionCompatibilityResult | null = null;
    let inlineMentionCompatibility: CodexInlineMentionCompatibilityResult | null = null;
    try {
      const installation = this.#officialCodexInstallation();
      inlineMentionCompatibility = await restoreCodexInlineMentionCompatibility({
        extensionPath: installation.extensionPath,
        extensionVersion: installation.extensionVersion,
        stateDirectory: codexInlineMentionCompatibilityDir(),
      });
      await this.#recordCodexInlineMentionCompatibility(
        "restore",
        inlineMentionCompatibility,
      );
      compatibility = await restoreOfficialExtensionCompatibility({
        extensionPath: installation.extensionPath,
        extensionVersion: installation.extensionVersion,
        stateDirectory: officialExtensionCompatibilityDir(),
        hostPlatform: process.platform,
      });
      this.#officialExtensionCompatibility = compatibility;
      if (compatibility.changed || compatibility.status === "conflict") {
        await this.#audit.write({
          operation: "official_extension.compatibility_restore",
          outcome: compatibility.status === "conflict" ? "failed" : "succeeded",
          details: { ...compatibility },
        });
      }
    } catch (error) {
      this.#log(`official Codex compatibility restoration skipped: ${String(error)}`);
    }
    const restored = await this.#settings.restore();
    if (
      compatibility?.status === "conflict" ||
      inlineMentionCompatibility?.status === "conflict"
    ) {
      void vscode.window.showErrorMessage(
        `Codex Bridge restored its saved settings but did not overwrite a changed official extension asset: ${inlineMentionCompatibility?.detail ?? compatibility?.detail ?? "compatibility state conflict"}`,
      );
    } else if (restored && (compatibility?.changed || inlineMentionCompatibility?.changed)) {
      void vscode.window.showInformationMessage(
        "Codex Bridge restored the previous official Codex settings and managed compatibility files. Reload VS Code.",
      );
    } else if (restored) {
      void vscode.window.showInformationMessage(
        "Codex Bridge restored the previous official Codex and Remote SSH settings. Reload VS Code.",
      );
    } else if (compatibility?.changed || inlineMentionCompatibility?.changed) {
      void vscode.window.showInformationMessage(
        "Codex Bridge restored the managed official Codex compatibility file. Reload VS Code.",
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
      {
        automaticLauncherPath: resolved.automaticLauncherPath,
        windowsAutomaticLauncher: resolved.windowsAutomaticLauncher,
      },
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
    this.#stopShimRuntimeMonitor();
    this.#executor?.close();
    this.#executor = null;
    try {
      await Promise.allSettled([
        this.#clearWindowSession(),
        clearLocalWorkspaceContext(this.#localWorkspaceContextPath),
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
        ...(connectionMode === "vscode-remote" ? [fullLocalAccessRoot()] : []),
      ],
      connectionMode,
      localExecution: "allow",
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

  #withFullLocalAccess(config: BridgeConfig): BridgeConfig {
    const primaryRoot = config.roots.find(
      (root) => root.target === "remote" && root.role === "primary",
    );
    if (!primaryRoot) {
      throw new BridgeError("INVALID_CONFIG", "The remote primary root is missing");
    }
    return parseBridgeConfig({
      ...config,
      workspaceRoot: primaryRoot.path,
      roots: [
        primaryRoot,
        ...(config.connectionMode === "vscode-remote"
          ? [fullLocalAccessRoot()]
          : []),
      ],
      localExecution: "allow",
    });
  }

  async #connect(): Promise<void> {
    if (!this.#config) {
      throw new BridgeError("INVALID_CONFIG", "Bridge is not configured");
    }
    this.#stopShimRuntimeMonitor();
    if (this.#config.connectionMode === "vscode-remote") {
      this.#setConnectionPhase("waiting-remote-extension-host");
      await this.#ensureRemoteExecutor();
    }
    this.#setConnectionPhase("probing-remote-workspace");
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
    this.#shimRuntimeHealth = await this.#readShimRuntimeHealth(this.#config);
    const connectedState = this.#shimRuntimeHealth.appServerInitialized
      ? "ready"
      : "degraded";
    this.#setConnectionPhase(
      connectedState === "ready" ? "idle" : "waiting-codex-app-server",
    );
    this.#state.transition(connectedState);
    this.#startShimRuntimeMonitor();
    await this.#audit.write({
      operation: "bridge.connect",
      outcome: "succeeded",
      state: connectedState,
      connectionId: this.#executor.connectionId,
      hostId: this.#config.host,
      workspaceRoot: this.#config.workspaceRoot,
      remoteCwd: this.#remoteIdentity.workspaceRoot,
      details: {
        connectionMode: this.#config.connectionMode,
        hostname: this.#remoteIdentity.hostname,
        machineId: this.#remoteIdentity.machineId,
        appServerInitialized: this.#shimRuntimeHealth.appServerInitialized,
        shimStarted: this.#shimRuntimeHealth.shimStarted,
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

  async #readShimRuntimeHealth(config: BridgeConfig): Promise<ShimRuntimeHealth> {
    try {
      const status = await loadShimRuntimeStatus(
        bridgeShimRuntimeStatusPath(config.host, config.workspaceRoot),
      );
      return shimRuntimeHealth(status, undefined, process.pid);
    } catch (error) {
      this.#log(`Shim runtime status unavailable: ${String(error)}`);
      return {
        ...EMPTY_SHIM_RUNTIME_HEALTH,
        appServerLastError:
          error instanceof Error ? error.message : String(error),
      };
    }
  }

  #startShimRuntimeMonitor(): void {
    this.#stopShimRuntimeMonitor();
    const generation = this.#shimRuntimeMonitorGeneration;
    const poll = async (): Promise<void> => {
      if (
        generation !== this.#shimRuntimeMonitorGeneration ||
        !this.#config ||
        !this.#executor
      ) {
        return;
      }
      const previous = this.#shimRuntimeHealth;
      this.#shimRuntimeHealth = await this.#readShimRuntimeHealth(this.#config);
      const currentState = this.#state.state;
      if (
        this.#shimRuntimeHealth.appServerInitialized &&
        currentState === "degraded"
      ) {
        this.#setConnectionPhase("idle");
        this.#state.transition("ready");
        this.#log("official Codex Shim and app-server initialization confirmed");
      } else if (
        !this.#shimRuntimeHealth.appServerInitialized &&
        currentState === "ready"
      ) {
        this.#setConnectionPhase("waiting-codex-app-server");
        this.#state.transition("degraded");
        this.#log("official Codex Shim or app-server heartbeat was lost");
      } else if (
        previous.appServerLastError !== this.#shimRuntimeHealth.appServerLastError ||
        previous.shimStarted !== this.#shimRuntimeHealth.shimStarted
      ) {
        this.#renderStatus();
      }
      if (
        generation === this.#shimRuntimeMonitorGeneration &&
        this.#executor
      ) {
        this.#shimRuntimeMonitor = setTimeout(() => void poll(), 1_000);
        this.#shimRuntimeMonitor.unref();
      }
    };
    this.#shimRuntimeMonitor = setTimeout(() => void poll(), 250);
    this.#shimRuntimeMonitor.unref();
  }

  #stopShimRuntimeMonitor(): void {
    this.#shimRuntimeMonitorGeneration += 1;
    if (this.#shimRuntimeMonitor) {
      clearTimeout(this.#shimRuntimeMonitor);
      this.#shimRuntimeMonitor = null;
    }
  }

  async #ensureRemoteExecutor(): Promise<void> {
    const markerKey = `codexRemoteBridge.executorInstall.${this.#config?.host ?? "remote"}`;
    const readiness = await this.#waitForRemoteExecutorCommand();
    const existing = readiness.response;
    const refreshCompatibleExecutor =
      existing !== null &&
      shouldRefreshRemoteExecutor(existing.packageVersion, REMOTE_EXECUTOR_VERSION);
    if (existing) {
      this.#log(
        `detected compatible Remote Executor package ${existing.packageVersion ?? "unreported"} (runtime ${existing.executorVersion ?? "unreported"}) after ${readiness.elapsedMs} ms and ${readiness.attempts} capability probe${readiness.attempts === 1 ? "" : "s"}`,
      );
    }
    if (existing && !refreshCompatibleExecutor) {
      await this.#context.globalState.update(markerKey, undefined);
      return;
    }

    if (refreshCompatibleExecutor) {
      this.#log(
        `replacing Remote Executor package ${existing.packageVersion ?? "unreported"} with bundled ${REMOTE_EXECUTOR_VERSION}`,
      );
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
      if (refreshCompatibleExecutor) {
        this.#log(
          `skipped optional Remote Executor refresh after ${installPlan.attempts} recent attempts`,
        );
        return;
      }
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
    try {
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
    } catch (error) {
      if (refreshCompatibleExecutor) {
        this.#log(`optional Remote Executor refresh failed: ${String(error)}`);
        return;
      }
      throw error;
    }
    this.#log("installed the Remote Executor through the active VS Code Remote connection");
    if (!refreshCompatibleExecutor) {
      const installedReadiness = await this.#waitForRemoteExecutorCommand();
      const installed = installedReadiness.response;
      if (installed) {
        await this.#context.globalState.update(markerKey, undefined);
        this.#log(
          `Remote Executor command became available without a window reload after ${installedReadiness.elapsedMs} ms and ${installedReadiness.attempts} capability probe${installedReadiness.attempts === 1 ? "" : "s"}`,
        );
        return;
      }
    }
    await this.#audit.write({
      operation: "executor.reload",
      outcome: "started",
      hostId: this.#config?.host,
      workspaceRoot: this.#config?.workspaceRoot,
      details: {
        automatic: true,
        executorVersion: REMOTE_EXECUTOR_VERSION,
        reason: refreshCompatibleExecutor
          ? "applied-new-bundled-executor"
          : "installed-executor-not-active",
      },
    });
    this.#log(
      `installed Remote Executor ${REMOTE_EXECUTOR_VERSION}; reloading the Remote SSH window automatically`,
    );
    void vscode.window.showInformationMessage(
      `Codex Bridge installed Remote Executor ${REMOTE_EXECUTOR_VERSION}. Reloading the Remote SSH window automatically.`,
    );
    await this.#reloadWindow();
    throw new BridgeError(
      "BRIDGE_NOT_READY",
      "Remote Executor installation triggered an automatic Remote SSH window reload",
    );
  }

  async #waitForRemoteExecutorCommand(retryWindowMs = 10_000): Promise<
    RemoteExecutorReadinessMetrics & { response: RemoteExecutorPing | null }
  > {
    const result = await waitForRemoteExecutorReadiness({
      isReady: isRemoteExecutorPing,
      onSlow: ({ attempts, elapsedMs }) => {
        this.#remoteExecutorReadiness = { attempts, elapsedMs, slow: true };
        this.#log(
          `waiting for the Remote Extension Host to answer the Executor capability probe (${elapsedMs} ms elapsed)`,
        );
        this.#renderStatus();
      },
      probe: async () =>
        await vscode.commands.executeCommand<unknown>(REMOTE_EXECUTOR_PING_COMMAND),
      retryWindowMs,
    });
    this.#remoteExecutorReadiness = {
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
      slow: result.slow,
    };
    await this.#audit.write({
      operation: "executor.readiness",
      outcome: result.response ? "succeeded" : "failed",
      state: this.#state.state,
      hostId: this.#config?.host,
      workspaceRoot: this.#config?.workspaceRoot,
      details: {
        attempts: result.attempts,
        durationMs: result.elapsedMs,
        slow: result.slow,
      },
    });
    return result;
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
    const shimPath = await installOfficialShimLauncher(this.#context);
    const controlDir = config
      ? bridgeRemoteControlDir(config.host, config.workspaceRoot)
      : bridgeControlDir();
    const shimHealth = config
      ? await this.#readShimRuntimeHealth(config)
      : { ...EMPTY_SHIM_RUNTIME_HEALTH };
    const workbenchDropCompatibility = await inspectWorkbenchDropCompatibility({
      appRoot: vscode.env.appRoot,
      stateDirectory: workbenchDropCompatibilityDir(),
    }).catch((error) => {
      this.#log(`Workbench drop compatibility diagnostics failed: ${String(error)}`);
      return null;
    });
    const codexInlineMentionCompatibility = codexExtension
      ? await inspectCodexInlineMentionCompatibility({
          extensionPath: codexExtension.extensionPath,
          extensionVersion:
            typeof codexExtension.packageJSON.version === "string"
              ? codexExtension.packageJSON.version
              : null,
          stateDirectory: codexInlineMentionCompatibilityDir(),
        }).catch((error) => {
          this.#log(`Codex inline mention compatibility diagnostics failed: ${String(error)}`);
          return null;
        })
      : null;
    return {
      generatedAt: new Date().toISOString(),
      bridge: {
        version: this.#context.extension.packageJSON.version as string,
        state: this.#state.state,
        configPath: bridgeConfigPath(),
        controlDir,
        startup: {
          phase: this.#connectionPhase,
          phaseStartedAt:
            this.#connectionPhaseStartedAtMs === null
              ? null
              : new Date(this.#connectionPhaseStartedAtMs).toISOString(),
          remoteExecutorAttempts: this.#remoteExecutorReadiness?.attempts ?? null,
          remoteExecutorWaitMs: this.#remoteExecutorReadiness?.elapsedMs ?? null,
          remoteExecutorWaitSlow: this.#remoteExecutorReadiness?.slow ?? false,
        },
        workspaceSemantics: {
          controlDirectory: {
            path: controlDir,
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
        nodeExecutable: shimHealth.nodeExecutable,
        shimStarted: shimHealth.shimStarted,
        shimPid: shimHealth.shimPid,
        shimLastExitCode: shimHealth.shimLastExitCode,
        appServerInitialized: shimHealth.appServerInitialized,
        appServerLastError: shimHealth.appServerLastError,
        officialSettings: this.#settings.status(shimPath),
        officialExtensionCompatibility: this.#officialExtensionCompatibility,
        codexInlineMentionCompatibility,
        workbenchDropCompatibility,
        automaticDropAuthorizationEnabled:
          this.#dropConsent.enabled(),
        fullLocalAccess: await this.#fullLocalAccessDiagnostics(config),
        conversationResources: this.#conversationResources.summary(),
      },
      remote: {
        identity: remoteIdentity,
        codexInstalled: remoteCodexInstalled,
        error: remoteError,
      },
      effectiveConfig: config,
    };
  }

  async #fullLocalAccessDiagnostics(config: BridgeConfig | null): Promise<{
    root: BridgeConfig["roots"][number];
    accessible: boolean;
    error: string | null;
  }> {
    const root = fullLocalAccessRoot();
    const configured = config?.roots.find(
      (candidate) =>
        candidate.id === root.id &&
        candidate.target === "local" &&
        candidate.role === "secondary" &&
        candidate.path === root.path,
    );
    if (!config || config.connectionMode !== "vscode-remote" || !configured) {
      return { root, accessible: false, error: "Full local access root is unavailable" };
    }
    try {
      const executor = new LocalWorkspaceExecutor(
        root.id,
        (rootId) => (rootId === root.id ? root : undefined),
        {
          commandTimeoutMs: config.commandTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
        },
      );
      await executor.canonicalPath(".");
      return { root, accessible: true, error: null };
    } catch (error) {
      return {
        root,
        accessible: false,
        error: asBridgeError(error, "COMMAND_DENIED").message,
      };
    }
  }

  #officialCodexInstallation(): {
    executable: string;
    extensionPath: string;
    extensionVersion: string | null;
  } {
    const extension = this.#officialCodexExtensionIdentity();
    return {
      executable: resolveOfficialCodexExecutable(extension.extensionPath),
      ...extension,
    };
  }

  #officialCodexExtensionIdentity(): {
    extensionPath: string;
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
      extensionPath: extension.extensionPath,
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

  async #reconcileOfficialExtensionCompatibility(): Promise<boolean> {
    const installation = this.#officialCodexInstallation();
    const result = await reconcileOfficialExtensionCompatibility({
      extensionPath: installation.extensionPath,
      extensionVersion: installation.extensionVersion,
      stateDirectory: officialExtensionCompatibilityDir(),
      hostPlatform: process.platform,
      remoteName: vscode.env.remoteName,
    });
    this.#officialExtensionCompatibility = result;
    if (result.status !== "not-applicable") {
      this.#log(
        `official Codex git-init watcher compatibility: ${result.status}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
    if (result.changed || result.status === "conflict" || result.status === "unsupported") {
      await this.#audit.write({
        operation: "official_extension.compatibility",
        outcome:
          result.status === "conflict" || result.status === "unsupported"
            ? "failed"
            : "succeeded",
        details: { ...result },
      });
    }
    if (!result.changed) {
      return false;
    }
    this.#log("official Codex git-init watcher compatibility applied; reloading the window once");
    await this.#reloadWindow();
    return true;
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
    this.#setConnectionPhase("idle");
    const next = error.code === "PROTOCOL_MISMATCH" ? "incompatible" : "disconnected";
    if (this.#state.state !== next) {
      this.#state.transition(next);
    }
  }

  #renderStatus(): void {
    const target = this.#config?.host ?? "unconfigured";
    const stateLabel =
      this.#state.state === "connecting" && this.#connectionPhase !== "idle"
        ? CONNECTION_PHASE_LABELS[this.#connectionPhase]
        : this.#state.state === "degraded" &&
            this.#remoteIdentity &&
            !this.#shimRuntimeHealth.appServerInitialized
          ? this.#shimRuntimeHealth.appServerLastError
            ? "remote ready; Codex failed"
            : this.#shimRuntimeHealth.shimStarted
              ? "remote ready; Codex starting"
              : "remote ready; waiting for Codex"
          : this.#state.state;
    this.#status.text = `${stateIcon(this.#state.state)} Codex: local -> ${target} (${stateLabel})`;
    this.#status.tooltip = this.#shimRuntimeHealth.appServerLastError
      ? this.#shimRuntimeHealth.appServerLastError
      : this.#connectionPhase === "waiting-remote-extension-host"
        ? "The Remote SSH window is open, but its Extension Host has not answered the Executor capability probe yet."
        : "Codex Remote Bridge diagnostics";
    this.#status.backgroundColor =
      this.#state.state === "incompatible" || this.#state.state === "disconnected"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : this.#state.state === "degraded"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
  }

  #setConnectionPhase(phase: ConnectionPhase): void {
    if (this.#connectionPhase === phase) {
      return;
    }
    this.#connectionPhase = phase;
    this.#connectionPhaseStartedAtMs = phase === "idle" ? null : Date.now();
    this.#renderStatus();
  }

  #log(message: string): void {
    this.#output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}
