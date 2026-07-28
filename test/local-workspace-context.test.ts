import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearLocalWorkspaceContext,
  LOCAL_WORKSPACE_ROOT_ENV,
  loadLocalWorkspaceContext,
  localWorkspaceContextPath,
  localWorkspaceRoot,
  publishLocalWorkspaceRoot,
  saveLocalWorkspaceContext,
  takeLocalWorkspaceRoot,
} from "../src/core/local-workspace-context.js";

const localFolder = {
  uri: {
    fsPath: "/home/zkbot/work/train/MimicLite",
    scheme: "file",
  },
};

describe("local workspace context", () => {
  it("publishes the only local file workspace root", () => {
    const environment: NodeJS.ProcessEnv = {};

    expect(publishLocalWorkspaceRoot(environment, undefined, [localFolder])).toBe(
      resolve(localFolder.uri.fsPath),
    );
    expect(environment[LOCAL_WORKSPACE_ROOT_ENV]).toBe(
      resolve(localFolder.uri.fsPath),
    );
  });

  it("does not guess a root for remote, multi-root, or non-file workspaces", () => {
    expect(localWorkspaceRoot("ssh-remote", [localFolder])).toBeNull();
    expect(localWorkspaceRoot(undefined, [localFolder, localFolder])).toBeNull();
    expect(
      localWorkspaceRoot(undefined, [
        { uri: { fsPath: "/virtual/project", scheme: "untitled" } },
      ]),
    ).toBeNull();
  });

  it("consumes a valid inherited root and clears stale or invalid values", () => {
    const environment: NodeJS.ProcessEnv = {
      [LOCAL_WORKSPACE_ROOT_ENV]: "/home/zkbot/work/train/MimicLite/../MimicLite",
    };
    expect(takeLocalWorkspaceRoot(environment)).toBe(
      resolve("/home/zkbot/work/train/MimicLite"),
    );
    expect(environment[LOCAL_WORKSPACE_ROOT_ENV]).toBeUndefined();

    environment[LOCAL_WORKSPACE_ROOT_ENV] = "relative/project";
    expect(takeLocalWorkspaceRoot(environment)).toBeNull();
    expect(environment[LOCAL_WORKSPACE_ROOT_ENV]).toBeUndefined();
  });

  it("shares a local workspace root by Extension Host PID without startup ordering", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codex-bridge-local-context-"));
    const contextPath = localWorkspaceContextPath(4321, stateDirectory);

    expect(await loadLocalWorkspaceContext(contextPath)).toBeNull();
    await saveLocalWorkspaceContext(contextPath, localFolder.uri.fsPath);
    expect(await loadLocalWorkspaceContext(contextPath)).toBe(
      resolve(localFolder.uri.fsPath),
    );
    expect(JSON.parse(await readFile(contextPath, "utf8"))).toEqual({
      version: 1,
      workspaceRoot: resolve(localFolder.uri.fsPath),
    });

    await clearLocalWorkspaceContext(contextPath);
    expect(await loadLocalWorkspaceContext(contextPath)).toBeNull();
  });
});
