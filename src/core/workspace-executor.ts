import type {
  DirectoryEntry,
  SearchMatch,
  TreeListing,
} from "./ssh-executor.js";
import type {
  RemoteCommandResult,
  RemoteFileRead,
  WorkspaceMutationResult,
  WorkspacePatchReplacement,
} from "./types.js";

export interface WorkspaceMutationOptions {
  expectedHash?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface WorkspaceExecutor {
  canonicalPath(inputPath: string): Promise<string>;
  readFile(inputPath: string, limitBytes?: number): Promise<RemoteFileRead>;
  listDirectory(inputPath: string): Promise<DirectoryEntry[]>;
  listTree(inputPath: string, depth?: number, maxEntries?: number): Promise<TreeListing>;
  search(
    query: string,
    inputPaths?: readonly string[],
    maxResults?: number,
  ): Promise<SearchMatch[]>;
  gitStatus(): Promise<RemoteCommandResult>;
  writeFile(
    inputPath: string,
    contentBase64: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult>;
  applyPatch(
    inputPath: string,
    replacements: readonly WorkspacePatchReplacement[],
    options: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult>;
  createDirectory(
    inputPath: string,
    options?: Omit<WorkspaceMutationOptions, "expectedHash">,
  ): Promise<WorkspaceMutationResult>;
  renamePath(
    inputPath: string,
    destinationPath: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult>;
  deletePath(
    inputPath: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult>;
}
