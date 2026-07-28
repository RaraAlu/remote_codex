import {
  isRecord,
  isRpcRequest,
  isRpcResponse,
  type RpcId,
  type RpcMessage,
} from "./rpc.js";
import { REMOTE_PERMISSION_PROFILE_ID } from "./local-core-policy.js";

export type RemoteApprovalMode = "ask" | "never";

type VisiblePermissionProfileId =
  | ":danger-full-access"
  | ":read-only"
  | ":workspace";

interface RemotePermissionPresentation {
  approvalPolicy: string;
  profileId: VisiblePermissionProfileId;
}

const DEFAULT_PRESENTATION: RemotePermissionPresentation = {
  approvalPolicy: "on-request",
  profileId: ":workspace",
};

function profileFromValue(
  value: unknown,
): VisiblePermissionProfileId | undefined {
  if (
    value === "full-access" ||
    value === "danger-full-access" ||
    value === "dangerFullAccess" ||
    value === ":danger-full-access"
  ) {
    return ":danger-full-access";
  }
  if (value === "read-only" || value === "readOnly" || value === ":read-only") {
    return ":read-only";
  }
  if (
    value === "workspace-write" ||
    value === "workspaceWrite" ||
    value === ":workspace"
  ) {
    return ":workspace";
  }
  return undefined;
}

function profileFromParams(
  params: Record<string, unknown>,
): VisiblePermissionProfileId | undefined {
  const sandboxPolicy = isRecord(params.sandboxPolicy)
    ? params.sandboxPolicy
    : null;
  const activePermissionProfile = isRecord(params.activePermissionProfile)
    ? params.activePermissionProfile
    : null;
  const config = isRecord(params.config) ? params.config : null;
  return (
    profileFromValue(sandboxPolicy?.type) ??
    profileFromValue(params.sandbox) ??
    profileFromValue(params.permissions) ??
    profileFromValue(activePermissionProfile?.id) ??
    profileFromValue(config?.sandbox_mode)
  );
}

function approvalPolicyFromParams(
  params: Record<string, unknown>,
): string | undefined {
  if (typeof params.approvalPolicy === "string") {
    return params.approvalPolicy;
  }
  const profileId =
    profileFromValue(params.permissions) ??
    profileFromValue(
      isRecord(params.activePermissionProfile)
        ? params.activePermissionProfile.id
        : undefined,
    );
  if (profileId === ":danger-full-access") {
    return "never";
  }
  if (profileId) {
    return "on-request";
  }
  if (params.approvalPolicy !== undefined && params.approvalPolicy !== null) {
    return "on-request";
  }
  if (typeof params.permissions === "string") {
    return "on-request";
  }
  return undefined;
}

function permissionPresentation(
  params: Record<string, unknown>,
  fallback: RemotePermissionPresentation,
): RemotePermissionPresentation {
  return {
    approvalPolicy:
      approvalPolicyFromParams(params) ?? fallback.approvalPolicy,
    profileId: profileFromParams(params) ?? fallback.profileId,
  };
}

function sandboxPolicy(
  profileId: VisiblePermissionProfileId,
): Record<string, unknown> {
  if (profileId === ":danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (profileId === ":read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function isInternalPermissionProfile(value: unknown): boolean {
  return isRecord(value) && value.id === REMOTE_PERMISSION_PROFILE_ID;
}

function withoutInternalPermission(
  value: unknown,
  emptyValue: null | undefined,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const hasInternalDefault =
    value.default_permissions === REMOTE_PERMISSION_PROFILE_ID;
  const permissions = isRecord(value.permissions) ? value.permissions : null;
  const hasInternalProfile =
    permissions !== null &&
    Object.hasOwn(permissions, REMOTE_PERMISSION_PROFILE_ID);
  if (!hasInternalDefault && !hasInternalProfile) {
    return value;
  }

  const projected = { ...value };
  if (hasInternalDefault) {
    if (emptyValue === undefined) {
      delete projected.default_permissions;
    } else {
      projected.default_permissions = emptyValue;
    }
  }
  if (hasInternalProfile && permissions) {
    const visiblePermissions = { ...permissions };
    delete visiblePermissions[REMOTE_PERMISSION_PROFILE_ID];
    if (Object.keys(visiblePermissions).length === 0) {
      if (emptyValue === undefined) {
        delete projected.permissions;
      } else {
        projected.permissions = emptyValue;
      }
    } else {
      projected.permissions = visiblePermissions;
    }
  }
  return projected;
}

function withoutInternalPermissionOrigins(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const permissions = isRecord(value.permissions) ? value.permissions : null;
  const hasInternalProfile =
    permissions !== null &&
    Object.hasOwn(permissions, REMOTE_PERMISSION_PROFILE_ID);
  const flatInternalKeys = Object.keys(value).filter(
    (key) =>
      key === `permissions.${REMOTE_PERMISSION_PROFILE_ID}` ||
      key.startsWith(`permissions.${REMOTE_PERMISSION_PROFILE_ID}.`),
  );
  if (
    !Object.hasOwn(value, "default_permissions") &&
    !hasInternalProfile &&
    flatInternalKeys.length === 0
  ) {
    return value;
  }
  const projected = { ...value };
  delete projected.default_permissions;
  for (const key of flatInternalKeys) {
    delete projected[key];
  }
  if (hasInternalProfile && permissions) {
    const visiblePermissions = { ...permissions };
    delete visiblePermissions[REMOTE_PERMISSION_PROFILE_ID];
    if (Object.keys(visiblePermissions).length === 0) {
      delete projected.permissions;
    } else {
      projected.permissions = visiblePermissions;
    }
  }
  return projected;
}

function projectPermissionProfileListResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return value;
  }
  const data = value.data.filter(
    (entry) =>
      !isRecord(entry) || entry.id !== REMOTE_PERMISSION_PROFILE_ID,
  );
  return data.length === value.data.length ? value : { ...value, data };
}

function projectConfigReadResult(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const config = withoutInternalPermission(value.config, null);
  if (config === value.config) {
    return value;
  }
  const origins = withoutInternalPermissionOrigins(value.origins);
  const layers = Array.isArray(value.layers)
    ? value.layers.map((layer) => {
        if (!isRecord(layer)) {
          return layer;
        }
        const layerConfig = withoutInternalPermission(layer.config, undefined);
        return layerConfig === layer.config
          ? layer
          : { ...layer, config: layerConfig };
      })
    : value.layers;
  return {
    ...value,
    config,
    origins,
    ...(Array.isArray(value.layers) ? { layers } : {}),
  };
}

function projectThreadSettings(
  value: unknown,
  presentation: RemotePermissionPresentation,
): unknown {
  if (
    !isRecord(value) ||
    !isInternalPermissionProfile(value.activePermissionProfile)
  ) {
    return value;
  }
  return {
    ...value,
    approvalPolicy: presentation.approvalPolicy,
    sandboxPolicy: sandboxPolicy(presentation.profileId),
    activePermissionProfile: {
      id: presentation.profileId,
      extends: null,
    },
  };
}

function projectThreadResult(
  value: unknown,
  presentation: RemotePermissionPresentation,
): unknown {
  if (
    !isRecord(value) ||
    !isInternalPermissionProfile(value.activePermissionProfile)
  ) {
    return value;
  }
  return {
    ...value,
    approvalPolicy: presentation.approvalPolicy,
    sandbox: sandboxPolicy(presentation.profileId),
    activePermissionProfile: {
      id: presentation.profileId,
      extends: null,
    },
  };
}

export class RemoteApprovalPolicyTracker {
  readonly #pendingThreadStarts = new Map<RpcId, RemotePermissionPresentation>();
  readonly #pendingPermissionProfileLists = new Set<RpcId>();
  readonly #permissionProfileListResponses = new Set<RpcId>();
  readonly #threadPresentations = new Map<string, RemotePermissionPresentation>();

  observeClientMessage(message: RpcMessage): void {
    if (!isRpcRequest(message) || !isRecord(message.params)) {
      return;
    }
    const params = message.params;

    if (message.method === "permissionProfile/list") {
      this.#pendingPermissionProfileLists.add(message.id);
      return;
    }
    if (message.method === "thread/start") {
      this.#pendingThreadStarts.set(
        message.id,
        permissionPresentation(params, DEFAULT_PRESENTATION),
      );
      return;
    }
    if (message.method === "thread/fork") {
      const fallback =
        typeof params.threadId === "string"
          ? this.#presentationForThread(params.threadId)
          : DEFAULT_PRESENTATION;
      this.#pendingThreadStarts.set(
        message.id,
        permissionPresentation(params, fallback),
      );
      return;
    }
    if (
      message.method !== "thread/resume" &&
      message.method !== "thread/settings/update" &&
      message.method !== "turn/start"
    ) {
      return;
    }
    if (typeof params.threadId !== "string") {
      return;
    }
    this.#threadPresentations.set(
      params.threadId,
      permissionPresentation(
        params,
        this.#presentationForThread(params.threadId),
      ),
    );
  }

  observeServerMessage(message: RpcMessage): void {
    if (!isRpcResponse(message)) {
      return;
    }
    if (this.#pendingPermissionProfileLists.delete(message.id)) {
      this.#permissionProfileListResponses.add(message.id);
    }
    const presentation = this.#pendingThreadStarts.get(message.id);
    if (!presentation) {
      return;
    }
    this.#pendingThreadStarts.delete(message.id);
    const thread =
      isRecord(message.result) && isRecord(message.result.thread)
        ? message.result.thread
        : null;
    if (typeof thread?.id === "string") {
      this.#threadPresentations.set(thread.id, presentation);
    }
  }

  modeForThread(threadId: string): RemoteApprovalMode {
    return this.#presentationForThread(threadId).approvalPolicy === "never"
      ? "never"
      : "ask";
  }

  requiresApproval(threadId: string): boolean {
    return this.modeForThread(threadId) !== "never";
  }

  projectServerMessage(message: RpcMessage): RpcMessage {
    if (isRpcResponse(message) && isRecord(message.result)) {
      if (this.#permissionProfileListResponses.delete(message.id)) {
        const profileResult = projectPermissionProfileListResult(message.result);
        return profileResult === message.result
          ? message
          : { ...message, result: profileResult };
      }
      const configResult = projectConfigReadResult(message.result);
      if (configResult !== message.result) {
        return { ...message, result: configResult };
      }
      const thread = isRecord(message.result.thread)
        ? message.result.thread
        : null;
      if (typeof thread?.id !== "string") {
        return message;
      }
      const result = projectThreadResult(
        message.result,
        this.#presentationForThread(thread.id),
      );
      return result === message.result ? message : { ...message, result };
    }
    if (
      !("method" in message) ||
      message.method !== "thread/settings/updated" ||
      !isRecord(message.params) ||
      typeof message.params.threadId !== "string"
    ) {
      return message;
    }
    const threadSettings = projectThreadSettings(
      message.params.threadSettings,
      this.#presentationForThread(message.params.threadId),
    );
    return threadSettings === message.params.threadSettings
      ? message
      : {
          ...message,
          params: {
            ...message.params,
            threadSettings,
          },
        };
  }

  #presentationForThread(threadId: string): RemotePermissionPresentation {
    return this.#threadPresentations.get(threadId) ?? DEFAULT_PRESENTATION;
  }
}
