import type {
  DirectoryEntry,
  SearchMatch,
  TreeListing,
} from "../core/ssh-executor.js";
import type {
  RemoteCommandResult,
  RemoteFileRead,
  WorkspaceMutationResult,
  WorkspacePatchReplacement,
} from "../core/types.js";
import type {
  ControllerWorkspaceClient,
  ControllerWorkspaceOperation,
} from "../core/vscode-transport.js";
import type {
  WorkspaceExecutor,
  WorkspaceMutationOptions,
} from "../core/workspace-executor.js";

export class ControllerWorkspaceExecutor implements WorkspaceExecutor {
  readonly #client: ControllerWorkspaceClient;
  readonly #rootId: string;

  constructor(rootId: string, client: ControllerWorkspaceClient) {
    this.#rootId = rootId;
    this.#client = client;
  }

  async canonicalPath(inputPath: string): Promise<string> {
    return await this.#request<string>("localCanonicalPath", { path: inputPath });
  }

  async readFile(inputPath: string, limitBytes?: number): Promise<RemoteFileRead> {
    return await this.#request<RemoteFileRead>("localReadFile", {
      path: inputPath,
      ...(limitBytes === undefined ? {} : { limitBytes }),
    });
  }

  async listDirectory(inputPath: string): Promise<DirectoryEntry[]> {
    return await this.#request<DirectoryEntry[]>("localListDirectory", {
      path: inputPath,
    });
  }

  async listTree(
    inputPath: string,
    depth = 2,
    maxEntries = 400,
  ): Promise<TreeListing> {
    return await this.#request<TreeListing>("localListTree", {
      depth,
      maxEntries,
      path: inputPath,
    });
  }

  async search(
    query: string,
    inputPaths: readonly string[] = ["."],
    maxResults = 200,
  ): Promise<SearchMatch[]> {
    return await this.#request<SearchMatch[]>("localSearch", {
      maxResults,
      paths: [...inputPaths],
      query,
    });
  }

  async gitStatus(): Promise<RemoteCommandResult> {
    return await this.#request<RemoteCommandResult>("localGitStatus", {});
  }

  async writeFile(
    inputPath: string,
    contentBase64: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    return await this.#request<WorkspaceMutationResult>("localWriteFile", {
      path: inputPath,
      contentBase64,
      ...options,
    });
  }

  async applyPatch(
    inputPath: string,
    replacements: readonly WorkspacePatchReplacement[],
    options: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult> {
    return await this.#request<WorkspaceMutationResult>("localApplyPatch", {
      path: inputPath,
      replacements: [...replacements],
      ...options,
    });
  }

  async createDirectory(
    inputPath: string,
    options: Omit<WorkspaceMutationOptions, "expectedHash"> = {},
  ): Promise<WorkspaceMutationResult> {
    return await this.#request<WorkspaceMutationResult>("localCreateDirectory", {
      path: inputPath,
      ...options,
    });
  }

  async renamePath(
    inputPath: string,
    destinationPath: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    return await this.#request<WorkspaceMutationResult>("localRenamePath", {
      path: inputPath,
      destinationPath,
      ...options,
    });
  }

  async deletePath(
    inputPath: string,
    options: WorkspaceMutationOptions = {},
  ): Promise<WorkspaceMutationResult> {
    return await this.#request<WorkspaceMutationResult>("localDeletePath", {
      path: inputPath,
      ...options,
    });
  }

  async #request<T>(
    operation: ControllerWorkspaceOperation,
    params: Record<string, unknown>,
  ): Promise<T> {
    return await this.#client.requestControllerWorkspace<T>(
      operation,
      this.#rootId,
      params,
    );
  }
}
