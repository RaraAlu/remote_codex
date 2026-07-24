import { BridgeError } from "../core/errors.js";
import type { BridgeConfig, WorkspaceRootConfig } from "../core/types.js";
import type { ControllerWorkspaceRequest } from "../core/vscode-transport.js";
import { LocalWorkspaceExecutor } from "./local-workspace-executor.js";

export class ControllerWorkspaceDispatcher {
  readonly #config: () => BridgeConfig | null;
  readonly #resolveAuthorizedRoot: (
    rootId: string,
  ) => WorkspaceRootConfig | undefined;

  constructor(
    config: () => BridgeConfig | null,
    resolveAuthorizedRoot: (rootId: string) => WorkspaceRootConfig | undefined,
  ) {
    this.#config = config;
    this.#resolveAuthorizedRoot = resolveAuthorizedRoot;
  }

  async execute(request: ControllerWorkspaceRequest): Promise<unknown> {
    const config = this.#config();
    if (!config || config.connectionMode !== "vscode-remote") {
      throw new BridgeError(
        "REMOTE_TRANSPORT_DISCONNECTED",
        "Controller workspace request has no active VS Code Remote session",
      );
    }
    const rootId = request.params.rootId;
    if (typeof rootId !== "string" || rootId.length === 0) {
      throw new BridgeError("PROTOCOL_MISMATCH", "params.rootId must be a non-empty string");
    }
    const configuredRoot = config.roots.find(
      (root) =>
        root.id === rootId &&
        root.target === "local" &&
        root.role === "secondary",
    );
    if (!configuredRoot) {
      throw new BridgeError("COMMAND_DENIED", "The local root is not configured", {
        rootId,
      });
    }
    const executor = new LocalWorkspaceExecutor(
      rootId,
      (candidateId) => {
        const authorized = this.#resolveAuthorizedRoot(candidateId);
        const configured = config.roots.find(
          (root) =>
            root.id === candidateId &&
            root.target === "local" &&
            root.role === "secondary",
        );
        return authorized && configured && authorized.path === configured.path
          ? authorized
          : undefined;
      },
      request.policy,
    );
    const requiredString = (key: string): string => {
      const value = request.params[key];
      if (typeof value !== "string") {
        throw new BridgeError("PROTOCOL_MISMATCH", `params.${key} must be a string`);
      }
      return value;
    };
    const numberValue = (key: string, fallback: number): number => {
      const value = request.params[key];
      if (value === undefined) {
        return fallback;
      }
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new BridgeError("PROTOCOL_MISMATCH", `params.${key} must be an integer`);
      }
      return value;
    };

    switch (request.operation) {
      case "localCanonicalPath":
        return await executor.canonicalPath(requiredString("path"));
      case "localReadFile":
        return await executor.readFile(
          requiredString("path"),
          numberValue("limitBytes", request.policy.maxOutputBytes / 2),
        );
      case "localListDirectory":
        return await executor.listDirectory(requiredString("path"));
      case "localListTree":
        return await executor.listTree(
          requiredString("path"),
          numberValue("depth", 2),
          numberValue("maxEntries", 400),
        );
      case "localSearch": {
        const requestedPaths =
          request.params.paths === undefined
            ? ["."]
            : Array.isArray(request.params.paths) &&
                request.params.paths.length <= 32 &&
                request.params.paths.every((entry) => typeof entry === "string")
              ? (request.params.paths as string[])
              : null;
        if (!requestedPaths) {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "params.paths must contain at most 32 strings",
          );
        }
        const paths = requestedPaths.length > 0 ? requestedPaths : ["."];
        return await executor.search(
          requiredString("query"),
          paths,
          numberValue("maxResults", 200),
        );
      }
      case "localGitStatus":
        return await executor.gitStatus();
    }
  }
}
