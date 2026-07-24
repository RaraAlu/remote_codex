import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { WorkspaceRootConfig } from "../src/core/types.js";
import type {
  ControllerWorkspaceOperation,
  ControllerWorkspaceRequest,
} from "../src/core/vscode-transport.js";
import { ControllerWorkspaceDispatcher } from "../src/extension/controller-workspace-dispatcher.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ControllerWorkspaceDispatcher", () => {
  it("executes bounded operations against an authorized root and observes revocation", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "codex-bridge-controller-workspace-"));
    directories.push(rootPath);
    await writeFile(join(rootPath, "notes.md"), "controller local read\n", "utf8");
    const localRoot: WorkspaceRootConfig = {
      id: "local-reference",
      target: "local",
      role: "secondary",
      path: rootPath,
      displayName: "reference",
    };
    const config = parseBridgeConfig({
      version: 2,
      host: "remote-host",
      roots: [
        {
          id: "remote-primary",
          target: "remote",
          role: "primary",
          path: "/remote/workspace",
          displayName: "workspace",
        },
        localRoot,
      ],
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
    });
    let authorizedRoot: WorkspaceRootConfig | undefined = localRoot;
    const dispatcher = new ControllerWorkspaceDispatcher(
      () => config,
      (rootId) => (authorizedRoot?.id === rootId ? authorizedRoot : undefined),
    );
    const request = (
      operation: ControllerWorkspaceOperation,
      params: Record<string, unknown> = {},
    ): ControllerWorkspaceRequest => ({
      hostId: config.host,
      id: operation,
      operation,
      params: {
        ...params,
        rootId: localRoot.id,
      },
      policy: {
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      workspaceRoot: config.workspaceRoot,
    });

    const result = await dispatcher.execute(
      request("localReadFile", { path: "notes.md" }),
    );
    expect(result).toMatchObject({
      canonicalPath: join(rootPath, "notes.md"),
      size: 22,
      truncated: false,
    });
    await expect(
      dispatcher.execute(request("localCanonicalPath", { path: "." })),
    ).resolves.toBe(rootPath);
    await expect(
      dispatcher.execute(request("localListDirectory", { path: "." })),
    ).resolves.toEqual([{ name: "notes.md", type: "file" }]);
    await expect(
      dispatcher.execute(
        request("localListTree", { depth: 2, maxEntries: 10, path: "." }),
      ),
    ).resolves.toMatchObject({
      entries: [{ path: "notes.md", type: "file" }],
      truncated: false,
    });
    await expect(
      dispatcher.execute(
        request("localSearch", { paths: [], query: "local read" }),
      ),
    ).resolves.toEqual([
      {
        lineNumber: 1,
        lines: "controller local read",
        path: join(rootPath, "notes.md"),
      },
    ]);
    await execFileAsync("git", ["init", "--quiet", rootPath]);
    await expect(
      dispatcher.execute(request("localGitStatus")),
    ).resolves.toMatchObject({
      actualCwd: rootPath,
      exitCode: 0,
      truncated: false,
    });

    authorizedRoot = undefined;
    await expect(
      dispatcher.execute(request("localReadFile", { path: "notes.md" })),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });
});
