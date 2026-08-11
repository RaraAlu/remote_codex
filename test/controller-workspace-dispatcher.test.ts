import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import type { ConversationResourceConfig } from "../src/core/types.js";
import type {
  ControllerWorkspaceOperation,
  ControllerWorkspaceRequest,
} from "../src/core/vscode-transport.js";
import { ControllerWorkspaceDispatcher } from "../src/extension/controller-workspace-dispatcher.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("ControllerWorkspaceDispatcher", () => {
  it("keeps a dropped directory read-only and scoped to its conversation", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "codex-conversation-workspace-"));
    directories.push(rootPath);
    await writeFile(join(rootPath, "notes.md"), "controller local read\n", "utf8");
    const resource: ConversationResourceConfig = {
      id: "context-reference",
      target: "local",
      role: "conversation",
      kind: "directory",
      path: rootPath,
      displayName: "reference",
      threadId: "thread-1",
    };
    const config = parseBridgeConfig({
      host: "remote-host",
      workspaceRoot: "/remote/workspace",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
    });
    let authorized = true;
    const dispatcher = new ControllerWorkspaceDispatcher(
      () => config,
      (threadId, rootId) =>
        authorized && threadId === resource.threadId && rootId === resource.id
          ? resource
          : undefined,
    );
    const request = (
      operation: ControllerWorkspaceOperation,
      params: Record<string, unknown> = {},
      threadId = "thread-1",
    ): ControllerWorkspaceRequest => ({
      hostId: config.host,
      id: operation,
      operation,
      params: {
        ...params,
        rootId: resource.id,
        threadId,
      },
      policy: {
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      workspaceRoot: config.workspaceRoot,
    });

    await expect(
      dispatcher.execute(request("localReadFile", { path: "notes.md" })),
    ).resolves.toMatchObject({
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

    for (const operation of [
      "localApplyPatch",
      "localCreateDirectory",
      "localDeletePath",
      "localGitStatus",
      "localRenamePath",
      "localWriteFile",
    ] as const) {
      await expect(dispatcher.execute(request(operation))).rejects.toMatchObject({
        code: "COMMAND_DENIED",
      });
    }
    await expect(
      dispatcher.execute(
        request("localReadFile", { path: "notes.md" }, "thread-2"),
      ),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });

    authorized = false;
    await expect(
      dispatcher.execute(request("localReadFile", { path: "notes.md" })),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it("allows only the exact dropped file", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "codex-conversation-file-"));
    directories.push(rootPath);
    const filePath = join(rootPath, "manual.pdf");
    await writeFile(filePath, "manual", "utf8");
    await writeFile(join(rootPath, "sibling.txt"), "sibling", "utf8");
    const resource: ConversationResourceConfig = {
      id: "context-manual",
      target: "local",
      role: "conversation",
      kind: "file",
      path: filePath,
      displayName: "manual.pdf",
      threadId: "thread-1",
    };
    const config = parseBridgeConfig({
      host: "remote-host",
      workspaceRoot: "/remote/workspace",
      connectionMode: "vscode-remote",
      remoteHelper: "vscode-extension",
    });
    const dispatcher = new ControllerWorkspaceDispatcher(
      () => config,
      (threadId, rootId) =>
        threadId === resource.threadId && rootId === resource.id
          ? resource
          : undefined,
    );
    const request = (path: string): ControllerWorkspaceRequest => ({
      hostId: config.host,
      id: path,
      operation: "localReadFile",
      params: { path, rootId: resource.id, threadId: resource.threadId },
      policy: {
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      workspaceRoot: config.workspaceRoot,
    });

    await expect(dispatcher.execute(request(filePath))).resolves.toMatchObject({
      canonicalPath: filePath,
      size: 6,
    });
    await expect(dispatcher.execute(request("manual.pdf"))).resolves.toMatchObject({
      canonicalPath: filePath,
    });
    await expect(dispatcher.execute(request("sibling.txt"))).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
  });
});
