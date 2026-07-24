import type {
  DirectoryEntry,
  SearchMatch,
  TreeListing,
} from "./ssh-executor.js";
import type { RemoteCommandResult, RemoteFileRead } from "./types.js";

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
}
