import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscodeTypes from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BridgeConfig,
  ConversationResourceConfig,
  WorkspaceRootConfig,
} from "../src/core/types.js";
import type { ControllerWorkspaceRequest } from "../src/core/vscode-transport.js";

const mock = vi.hoisted(() => ({
  activeTextEditor: null as vscodeTypes.TextEditor | null,
  executeCommand: vi.fn(async () => undefined),
  findFiles: vi.fn(async () => [] as vscodeTypes.Uri[]),
  openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  readFile: vi.fn(async () => new Uint8Array(Buffer.from("live\n"))),
  remoteContext: null as null | {
    host: string;
    workspaceRoot: string;
    workspaceUri: vscodeTypes.Uri;
  },
  showTextDocument: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 5 })),
}));

vi.mock("vscode", () => {
  class Uri {
    readonly value: string;

    constructor(value: string) {
      this.value = value;
    }

    static file(path: string): Uri {
      return new Uri(`file://${path}`);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
      const parsed = new URL(base.value);
      parsed.pathname = [parsed.pathname.replace(/\/$/, ""), ...segments]
        .join("/")
        .replaceAll(/\/+/g, "/");
      return new Uri(parsed.toString());
    }

    static parse(value: string): Uri {
      return new Uri(value);
    }

    get authority(): string {
      return new URL(this.value).host;
    }

    get path(): string {
      return decodeURIComponent(new URL(this.value).pathname);
    }

    get scheme(): string {
      return new URL(this.value).protocol.slice(0, -1);
    }

    get fsPath(): string {
      return this.path;
    }

    toString(): string {
      return this.value;
    }
  }

  class Range {
    readonly start: { character: number; line: number };
    readonly end: { character: number; line: number };

    constructor(
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
    ) {
      this.start = { character: startCharacter, line: startLine };
      this.end = { character: endCharacter, line: endLine };
    }
  }

  class RelativePattern {
    readonly base: Uri;
    readonly pattern: string;

    constructor(base: Uri, pattern: string) {
      this.base = base;
      this.pattern = pattern;
    }
  }

  return {
    Range,
    RelativePattern,
    Uri,
    commands: { executeCommand: mock.executeCommand },
    window: {
      get activeTextEditor() {
        return mock.activeTextEditor;
      },
      showTextDocument: mock.showTextDocument,
    },
    workspace: {
      findFiles: mock.findFiles,
      fs: {
        readFile: mock.readFile,
        stat: mock.stat,
      },
      openTextDocument: mock.openTextDocument,
      registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
});

vi.mock("../src/extension/remote-context.js", () => ({
  detectRemoteWorkspace: () => {
    if (!mock.remoteContext) {
      throw new Error("remote context not configured");
    }
    return mock.remoteContext;
  },
}));

import * as vscode from "vscode";
import {
  WorkspaceResourceController,
} from "../src/extension/workspace-resource-controller.js";

const remoteRoot: WorkspaceRootConfig = {
  displayName: "Zklab",
  id: "remote-primary",
  path: "/home/zkbot/work/train/zklab/Zklab",
  role: "primary",
  target: "remote",
};

const localResource: ConversationResourceConfig = {
  displayName: "notes",
  id: "context-notes",
  kind: "directory",
  path: "/tmp/bridge-notes",
  role: "conversation",
  target: "local",
  threadId: "thread-1",
};

function config(roots: WorkspaceRootConfig[] = [remoteRoot]): BridgeConfig {
  return {
    commandTimeoutMs: 120_000,
    connectTimeoutSeconds: 10,
    connectionMode: "vscode-remote",
    host: "test_40",
    localExecution: "deny",
    maxOutputBytes: 10 * 1024 * 1024,
    maxParallelReads: 8,
    maxParallelWrites: 1,
    remoteHelper: "vscode-extension",
    remoteMcpAccess: "enabled",
    remoteMcpRouting: "auto",
    roots,
    sshExecutable: "ssh",
    version: 2,
    workspaceRoot: remoteRoot.path,
  };
}

function request(
  operation:
    | "resolveEditorContext"
    | "resolveFuzzyFileSearch"
    | "openWorkspaceResource"
    | "registerWorkspaceResource"
    | "showWorkspaceDiff",
  rootId: string,
  params: Record<string, unknown>,
): ControllerWorkspaceRequest {
  return {
    hostId: "test_40",
    id: "request-1",
    operation,
    params: { rootId, ...params },
    policy: {
      commandTimeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
    },
    workspaceRoot: remoteRoot.path,
  };
}

describe("WorkspaceResourceController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.findFiles.mockResolvedValue([]);
    mock.activeTextEditor = null;
    mock.remoteContext = {
      host: "test_40",
      workspaceRoot: remoteRoot.path,
      workspaceUri: vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab",
      ),
    };
  });

  it("reuses the exact open Remote SSH workspace URI for an editor jump", async () => {
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    const result = (await controller.execute(
      request("openWorkspaceResource", remoteRoot.id, {
        column: 3,
        endColumn: 7,
        line: 4,
        path: `${remoteRoot.path}/src/main.py`,
      }),
    )) as Record<string, unknown>;

    expect(mock.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        value:
          "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/src/main.py",
      }),
    );
    expect(mock.showTextDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preview: true,
        selection: expect.objectContaining({
          start: { character: 2, line: 3 },
          end: { character: 6, line: 3 },
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        action: "opened",
        relativePath: "src/main.py",
        resourceUri: expect.stringContaining(
          "codex-bridge://workspace/remote-primary/src/main.py",
        ),
      }),
    );
    expect(
      await controller.provideTextDocumentContent(
        vscode.Uri.parse(result.resourceUri as string),
      ),
    ).toBe("live\n");
    expect(mock.readFile).toHaveBeenCalledWith(
      expect.objectContaining({
        value:
          "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/src/main.py",
      }),
    );
  });

  it("searches and ranks files inside the exact Remote SSH workspace", async () => {
    mock.findFiles.mockResolvedValue([
      vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/docs/recording.md",
      ),
      vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/src/locomotion/scripts/record_torque.py",
      ),
      vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Bother-host/home/zkbot/work/train/zklab/Zklab/record_torque.py",
      ),
    ]);
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    const result = await controller.execute(
      request("resolveFuzzyFileSearch", remoteRoot.id, {
        maxResults: 10,
        query: "record_torque",
      }),
    );

    expect(mock.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: expect.stringMatching(/^\*\*\/.*\[rR\].*\[tT\]/),
      }),
      undefined,
      50_001,
    );
    expect(result).toEqual({
      files: [
        expect.objectContaining({
          file_name: "record_torque.py",
          match_type: "file",
          path: "src/locomotion/scripts/record_torque.py",
          root: remoteRoot.path,
        }),
      ],
      scannedFileCount: 3,
      truncated: false,
    });
  });

  it("opens a verified in-memory before snapshot against the live remote URI", async () => {
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );
    const before = Buffer.from("before\n");
    const beforeHash = createHash("sha256").update(before).digest("hex");

    const result = (await controller.execute(
      request("showWorkspaceDiff", remoteRoot.id, {
        beforeContentBase64: before.toString("base64"),
        beforeHash,
        path: `${remoteRoot.path}/src/main.py`,
        title: "Review main.py",
      }),
    )) as Record<string, unknown>;

    expect(mock.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.objectContaining({
        value: expect.stringContaining(`revision=${beforeHash}`),
      }),
      expect.objectContaining({
        value:
          "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/src/main.py",
      }),
      "Review main.py",
      { preview: true },
    );
    expect(
      await controller.provideTextDocumentContent(
        vscode.Uri.parse(result.snapshotUri as string),
      ),
    ).toBe("before\n");
  });

  it("rejects a snapshot whose content does not match its hash", async () => {
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    await expect(
      controller.execute(
        request("showWorkspaceDiff", remoteRoot.id, {
          beforeContentBase64: Buffer.from("changed").toString("base64"),
          beforeHash: "a".repeat(64),
          path: `${remoteRoot.path}/src/main.py`,
        }),
      ),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(mock.executeCommand).not.toHaveBeenCalled();
  });

  it("accepts an empty text file as a valid Diff before snapshot", async () => {
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );
    const beforeHash = createHash("sha256").update("").digest("hex");

    await expect(
      controller.execute(
        request("showWorkspaceDiff", remoteRoot.id, {
          beforeContentBase64: "",
          beforeHash,
          path: `${remoteRoot.path}/src/empty.py`,
        }),
      ),
    ).resolves.toMatchObject({ action: "diffed", beforeHash });
  });

  it("requires a still-authorized resource in the same conversation before opening it", async () => {
    let authorized = true;
    const controller = new WorkspaceResourceController(
      () => config(),
      (threadId, rootId) =>
        authorized && threadId === "thread-1" && rootId === localResource.id
          ? localResource
          : undefined,
    );

    await controller.execute(
      request("openWorkspaceResource", localResource.id, {
        path: `${localResource.path}/todo.md`,
        threadId: "thread-1",
      }),
    );
    expect(mock.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ value: "file:///tmp/bridge-notes/todo.md" }),
    );

    authorized = false;
    await expect(
      controller.execute(
        request("openWorkspaceResource", localResource.id, {
          path: `${localResource.path}/todo.md`,
          threadId: "thread-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
  });

  it.skipIf(process.platform === "win32")(
    "invalidates an already registered conversation resource after thread cleanup",
    async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-resource-provider-"));
    const path = join(directory, "manual.txt");
    await writeFile(path, "manual\n", "utf8");
    const resource: ConversationResourceConfig = {
      id: "context-manual",
      target: "local",
      role: "conversation",
      kind: "file",
      path,
      displayName: "manual.txt",
      threadId: "thread-1",
    };
    let authorized = true;
    const controller = new WorkspaceResourceController(
      () => config(),
      (threadId, rootId) =>
        authorized && threadId === resource.threadId && rootId === resource.id
          ? resource
          : undefined,
    );

    try {
      const registered = (await controller.execute(
        request("registerWorkspaceResource", resource.id, {
          path,
          threadId: resource.threadId,
        }),
      )) as { resourceUri: string };
      authorized = false;
      await expect(
        controller.provideTextDocumentContent(
          vscode.Uri.parse(registered.resourceUri),
        ),
      ).rejects.toMatchObject({ code: "COMMAND_DENIED" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses a resource URI after its host identity changes", async () => {
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );
    const uri = vscode.Uri.parse(
      "codex-bridge://workspace/remote-primary/src/main.py?host=other&target=remote",
    );

    await expect(controller.provideTextDocumentContent(uri)).rejects.toMatchObject({
      code: "COMMAND_DENIED",
    });
    expect(mock.readFile).not.toHaveBeenCalled();
  });

  it("refuses an otherwise valid resource URI that this session did not register", async () => {
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );
    const uri = vscode.Uri.parse(
      "codex-bridge://workspace/remote-primary/src/main.py?host=test_40&target=remote",
    );

    await expect(controller.provideTextDocumentContent(uri)).rejects.toMatchObject({
      code: "COMMAND_DENIED",
    });
    expect(mock.readFile).not.toHaveBeenCalled();
  });

  it("uses one explicit remote selection before returning to automatic IDE context", async () => {
    const selection = {
      end: { character: 30, line: 1 },
      isEmpty: false,
      start: { character: 0, line: 1 },
    };
    const document = {
      getText: vi.fn((range?: unknown) =>
        range ? "REMOTE_SELECTION_LINE_L03_0331" : "whole file",
      ),
      languageId: "plaintext",
      uri: vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/context.txt",
      ),
    };
    mock.activeTextEditor = {
      document,
      selection,
    } as unknown as vscodeTypes.TextEditor;
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    const queued = await controller.captureEditorContext("selection");

    expect(queued).toMatchObject({
      content: "REMOTE_SELECTION_LINE_L03_0331",
      hostId: "test_40",
      kind: "selection",
      origin: "explicit",
      relativePath: "context.txt",
      rootId: "remote-primary",
      selection: {
        start: { column: 1, line: 2 },
        end: { column: 31, line: 2 },
      },
      sizeBytes: 30,
      target: "remote",
      workspaceRoot: remoteRoot.path,
      workspaceUri:
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/context.txt",
    });
    expect(queued.contentHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      controller.execute(request("resolveEditorContext", remoteRoot.id, {})),
    ).resolves.toEqual(queued);
    const automatic = await controller.execute(
      request("resolveEditorContext", remoteRoot.id, {}),
    );
    expect(automatic).toMatchObject({
      content: "REMOTE_SELECTION_LINE_L03_0331",
      kind: "selection",
      origin: "automatic",
    });
    expect((automatic as { contextId: string }).contextId).not.toBe(queued.contextId);
  });

  it("automatically captures the complete active remote file without a selection", async () => {
    const document = {
      getText: vi.fn(() => "REMOTE_ACTIVE_FILE\n"),
      languageId: "plaintext",
      uri: vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/active.txt",
      ),
    };
    mock.activeTextEditor = {
      document,
      selection: {
        end: { character: 0, line: 0 },
        isEmpty: true,
        start: { character: 0, line: 0 },
      },
    } as unknown as vscodeTypes.TextEditor;
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    await expect(
      controller.execute(request("resolveEditorContext", remoteRoot.id, {})),
    ).resolves.toMatchObject({
      content: "REMOTE_ACTIVE_FILE\n",
      kind: "file",
      origin: "automatic",
      relativePath: "active.txt",
      sizeBytes: 19,
    });
  });

  it("rejects editor context outside the active Remote SSH workspace", async () => {
    mock.activeTextEditor = {
      document: {
        getText: () => "LOCAL_BAIT",
        languageId: "plaintext",
        uri: vscode.Uri.parse("file:///tmp/local-bait.txt"),
      },
      selection: {
        end: { character: 10, line: 0 },
        isEmpty: false,
        start: { character: 0, line: 0 },
      },
    } as unknown as vscodeTypes.TextEditor;
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    await expect(controller.captureEditorContext("selection")).rejects.toMatchObject({
      code: "COMMAND_DENIED",
    });
    await expect(
      controller.execute(request("resolveEditorContext", remoteRoot.id, {})),
    ).resolves.toBeNull();
  });

  it("fails closed when the active Remote SSH identity no longer matches", async () => {
    mock.activeTextEditor = {
      document: {
        getText: () => "REMOTE_BAIT",
        languageId: "plaintext",
        uri: vscode.Uri.parse(
          "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/context.txt",
        ),
      },
      selection: {
        end: { character: 0, line: 0 },
        isEmpty: true,
        start: { character: 0, line: 0 },
      },
    } as unknown as vscodeTypes.TextEditor;
    mock.remoteContext = {
      host: "other-host",
      workspaceRoot: remoteRoot.path,
      workspaceUri: vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Bother-host/home/zkbot/work/train/zklab/Zklab",
      ),
    };
    const controller = new WorkspaceResourceController(
      () => config(),
      () => undefined,
    );

    await expect(
      controller.execute(request("resolveEditorContext", remoteRoot.id, {})),
    ).rejects.toMatchObject({
      code: "REMOTE_TRANSPORT_DISCONNECTED",
    });
  });
});
