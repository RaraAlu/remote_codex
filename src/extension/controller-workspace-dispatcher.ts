import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.js";
import {
  OperationLedger,
  type IdempotencyOutcome,
} from "../core/operation-ledger.js";
import type { BridgeConfig, WorkspaceToolRoot } from "../core/types.js";
import type { ControllerWorkspaceRequest } from "../core/vscode-transport.js";
import { LocalWorkspaceExecutor } from "./local-workspace-executor.js";

export class ControllerWorkspaceDispatcher {
  readonly #config: () => BridgeConfig | null;
  readonly #mutationLedger = new OperationLedger();
  readonly #resolveAuthorizedRoot: (
    threadId: string,
    rootId: string,
  ) => WorkspaceToolRoot | undefined;

  constructor(
    config: () => BridgeConfig | null,
    resolveAuthorizedRoot: (
      threadId: string,
      rootId: string,
    ) => WorkspaceToolRoot | undefined,
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
    const threadId = request.params.threadId;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new BridgeError("PROTOCOL_MISMATCH", "params.threadId must be a non-empty string");
    }
    const authorizedRoot = this.#resolveAuthorizedRoot(threadId, rootId);
    const conversationResource =
      authorizedRoot?.target === "local" &&
      authorizedRoot.role === "conversation" &&
      authorizedRoot.threadId === threadId
        ? authorizedRoot
        : undefined;
    if (!conversationResource) {
      throw new BridgeError("COMMAND_DENIED", "The conversation resource is not authorized", {
        rootId,
        threadId,
      });
    }
    if (
      conversationResource &&
      (request.operation === "localApplyPatch" ||
        request.operation === "localCreateDirectory" ||
        request.operation === "localDeletePath" ||
        request.operation === "localGitStatus" ||
        request.operation === "localRenamePath" ||
        request.operation === "localWriteFile")
    ) {
      throw new BridgeError(
        "COMMAND_DENIED",
        "Dropped conversation resources are read-only",
        { rootId, threadId },
      );
    }
    const executor = new LocalWorkspaceExecutor(
      rootId,
      (candidateId) => {
        const authorized = this.#resolveAuthorizedRoot(threadId, candidateId);
        return authorized?.role === "conversation" &&
          authorized.threadId === threadId
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
    const optionalString = (key: string): string | undefined => {
      const value = request.params[key];
      if (value === undefined) {
        return undefined;
      }
      if (typeof value !== "string") {
        throw new BridgeError("PROTOCOL_MISMATCH", `params.${key} must be a string`);
      }
      return value;
    };
    const mutationOptions = () => ({
      ...(optionalString("expectedHash") === undefined
        ? {}
        : { expectedHash: optionalString("expectedHash") }),
      ...(optionalString("idempotencyKey") === undefined
        ? {}
        : { idempotencyKey: optionalString("idempotencyKey") }),
    });

    switch (request.operation) {
      case "localApplyPatch": {
        const replacements = request.params.replacements;
        if (
          !Array.isArray(replacements) ||
          !replacements.every(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              typeof (entry as Record<string, unknown>).oldText === "string" &&
              typeof (entry as Record<string, unknown>).newText === "string",
          )
        ) {
          throw new BridgeError(
            "PROTOCOL_MISMATCH",
            "params.replacements must be text replacement objects",
          );
        }
        return await this.#runMutation(
          request,
          async () =>
            await executor.applyPatch(
              requiredString("path"),
              replacements as Array<{ oldText: string; newText: string }>,
              mutationOptions(),
            ),
        );
      }
      case "localCanonicalPath":
        return await executor.canonicalPath(requiredString("path"));
      case "localCreateDirectory":
        return await this.#runMutation(
          request,
          async () =>
            await executor.createDirectory(requiredString("path"), {
              ...(optionalString("idempotencyKey") === undefined
                ? {}
                : { idempotencyKey: optionalString("idempotencyKey") }),
            }),
        );
      case "localDeletePath":
        return await this.#runMutation(
          request,
          async () =>
            await executor.deletePath(
              requiredString("path"),
              mutationOptions(),
            ),
        );
      case "localReadFile":
        return await executor.readFile(
          requiredString("path"),
          numberValue("limitBytes", request.policy.maxOutputBytes / 2),
        );
      case "localRenamePath":
        return await this.#runMutation(
          request,
          async () =>
            await executor.renamePath(
              requiredString("path"),
              requiredString("destinationPath"),
              mutationOptions(),
            ),
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
      case "localWriteFile":
        return await this.#runMutation(
          request,
          async () =>
            await executor.writeFile(
              requiredString("path"),
              requiredString("contentBase64"),
              mutationOptions(),
            ),
        );
    }
  }

  async #runMutation(
    request: ControllerWorkspaceRequest,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const idempotencyKey = request.params.idempotencyKey;
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 256 ||
      idempotencyKey.includes("\0")
    ) {
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "params.idempotencyKey must contain 1 to 256 NUL-free characters",
      );
    }
    const { idempotencyKey: _ignored, ...params } = request.params;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          canonicalValue({
            operation: request.operation,
            params,
            policy: request.policy,
          }),
        ),
      )
      .digest("hex");
    const handle = this.#mutationLedger.start(
      `${request.params.rootId}\0${idempotencyKey}`,
      request.id,
      fingerprint,
      async () => await operation(),
    );
    return resultWithIdempotencyOutcome(await handle.result, handle.outcome);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function resultWithIdempotencyOutcome(
  result: unknown,
  outcome: IdempotencyOutcome,
): unknown {
  return result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), idempotencyOutcome: outcome }
    : { value: result, idempotencyOutcome: outcome };
}
