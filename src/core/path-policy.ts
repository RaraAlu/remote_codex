import { posix } from "node:path";
import { BridgeError } from "./errors.js";

export interface NormalizedRemotePath {
  absolutePath: string;
  relativePath: string;
}

export function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function normalizeRemotePath(root: string, inputPath: string): NormalizedRemotePath {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) {
    throw new BridgeError("PATH_OUTSIDE_ROOT", "Remote path must be a NUL-free string");
  }

  const absolutePath = posix.isAbsolute(inputPath)
    ? posix.normalize(inputPath)
    : posix.resolve(root, inputPath || ".");

  if (!isPathInside(root, absolutePath)) {
    throw new BridgeError("PATH_OUTSIDE_ROOT", "Remote path escapes the configured workspace", {
      root,
      path: inputPath,
    });
  }

  return {
    absolutePath,
    relativePath: posix.relative(root, absolutePath) || ".",
  };
}
