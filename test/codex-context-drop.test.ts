import type * as vscodeTypes from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  commandIds: ["chatgpt.addFileToThread"],
  executeCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  remoteName: null as string | null,
  stat: vi.fn<(uri: vscodeTypes.Uri) => Promise<vscodeTypes.FileStat>>(async () => ({
    ctime: 0,
    mtime: 0,
    size: 1,
    type: 1,
  })),
  workspaceFolders: undefined as vscodeTypes.WorkspaceFolder[] | undefined,
}));

vi.mock("vscode", () => {
  class Uri {
    readonly authority: string;
    readonly fragment: string;
    readonly path: string;
    readonly query: string;
    readonly scheme: string;

    constructor(
      scheme: string,
      authority: string,
      path: string,
      query = "",
      fragment = "",
    ) {
      this.authority = authority;
      this.fragment = fragment;
      this.path = path;
      this.query = query;
      this.scheme = scheme;
    }

    static file(path: string): Uri {
      const normalized = path.replaceAll("\\", "/");
      return new Uri("file", "", normalized.startsWith("/") ? normalized : `/${normalized}`);
    }

    static parse(value: string): Uri {
      const parsed = new URL(value);
      return new Uri(
        parsed.protocol.slice(0, -1),
        decodeURIComponent(parsed.host),
        decodeURIComponent(parsed.pathname),
        parsed.search.slice(1),
        parsed.hash.slice(1),
      );
    }

    get fsPath(): string {
      return this.path;
    }

    toString(): string {
      const query = this.query ? `?${this.query}` : "";
      const fragment = this.fragment ? `#${this.fragment}` : "";
      return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
    }

    with(change: { fragment?: string | null }): Uri {
      return new Uri(
        this.scheme,
        this.authority,
        this.path,
        this.query,
        change.fragment === undefined ? this.fragment : (change.fragment ?? ""),
      );
    }
  }

  return {
    FileType: { Directory: 2, File: 1, SymbolicLink: 64, Unknown: 0 },
    Uri,
    commands: {
      executeCommand: mock.executeCommand,
      getCommands: vi.fn(async () => mock.commandIds),
    },
    env: {
      get remoteName() {
        return mock.remoteName;
      },
    },
    workspace: {
      fs: { stat: mock.stat },
      get workspaceFolders() {
        return mock.workspaceFolders;
      },
    },
  };
});

import * as vscode from "vscode";
import {
  attachDroppedResourcesToCodex,
  extractWorkbenchDropPayloadUris,
  parseWorkbenchDropPayload,
} from "../src/extension/codex-context-drop.js";
import { CODEX_INLINE_MENTION_PATH_MARKER } from "../src/extension/codex-inline-mention-patch.js";

describe("Codex Workbench drop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.commandIds = ["chatgpt.addFileToThread"];
    mock.remoteName = null;
    mock.workspaceFolders = undefined;
    mock.stat.mockImplementation(async (uri: vscodeTypes.Uri) => ({
      type: uri.path.endsWith("/folder") ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 1,
    }));
  });

  it("collects Workbench URI lists and native file paths without duplicates", () => {
    const parsed = parseWorkbenchDropPayload({
      schemaVersion: 1,
      internalUriList:
        "# explorer\nfile:///tmp/local.py\nvscode-remote://ssh-remote%2Bdev/work/a.py",
      resourceUrls: '["file:///tmp/other.py"]',
      codeFiles: '["/tmp/local.py"]',
      nativeFilePaths: ["/tmp/desktop.py"],
    });

    expect(parsed.source).toBe("vscode-explorer");
    expect(parsed.resources.map((resource) => resource.toString())).toEqual([
      "file:///tmp/local.py",
      "vscode-remote://ssh-remote+dev/work/a.py",
      "file:///tmp/other.py",
      "file:///tmp/desktop.py",
    ]);
  });

  it("classifies URI-list-only native drops as system file manager input", () => {
    const parsed = parseWorkbenchDropPayload({
      schemaVersion: 1,
      uriList: "file:///tmp/outside.txt",
      nativeFilePaths: ["/tmp/outside.txt"],
    });

    expect(parsed.source).toBe("system-file-manager");
    expect(parsed.resources.map((resource) => resource.fsPath)).toEqual([
      "/tmp/outside.txt",
    ]);
  });

  it("adds local files and folders through the official command with folder semantics", async () => {
    const logs: string[] = [];
    const result = await attachDroppedResourcesToCodex(
      [
        vscode.Uri.file("/work/main.py"),
        vscode.Uri.file("/work/folder"),
        vscode.Uri.file("/work/main.py"),
      ],
      { log: (message) => logs.push(message) },
    );

    expect(mock.executeCommand).toHaveBeenCalledTimes(2);
    expect(mock.executeCommand.mock.calls[0]?.[0]).toBe("chatgpt.addFileToThread");
    expect((mock.executeCommand.mock.calls[0]?.[1] as vscodeTypes.Uri).fsPath).toBe(
      "/work/main.py",
    );
    expect((mock.executeCommand.mock.calls[1]?.[1] as vscodeTypes.Uri).fsPath).toBe(
      "/work/folder/",
    );
    expect(result).toEqual({
      attachedCount: 2,
      directoryCount: 1,
      duplicateCount: 1,
      failedCount: 0,
      fileCount: 1,
      firstFailure: null,
      localCount: 2,
      remoteCount: 0,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'phase.attach.map index=0 source="local-file" insertionMode="attachment" official=uri="file:///work/main.py"',
        ),
        expect.stringContaining(
          'phase.attach.map index=1 source="local-file" insertionMode="attachment" official=uri="file:///work/folder/"',
        ),
        "phase.attach.complete attached=2 failed=0 duplicates=1 files=1 directories=1 local=2 remote=0",
      ]),
    );
  });

  it("marks VS Code Explorer resources for cursor-positioned inline mentions", async () => {
    await attachDroppedResourcesToCodex(
      [vscode.Uri.file("/work/main.py"), vscode.Uri.file("/work/folder")],
      { insertionMode: "inline-mention" },
    );

    expect(mock.executeCommand).toHaveBeenCalledTimes(2);
    expect((mock.executeCommand.mock.calls[0]?.[1] as vscodeTypes.Uri).fsPath).toBe(
      `/work/main.py${CODEX_INLINE_MENTION_PATH_MARKER}`,
    );
    expect((mock.executeCommand.mock.calls[1]?.[1] as vscodeTypes.Uri).fsPath).toBe(
      `/work/folder${CODEX_INLINE_MENTION_PATH_MARKER}/`,
    );
  });

  it("maps only resources from the exact active Remote SSH workspace", async () => {
    mock.remoteName = "ssh-remote";
    mock.workspaceFolders = [
      {
        index: 0,
        name: "project",
        uri: vscode.Uri.parse("vscode-remote://ssh-remote%2Bdev/home/unitree/project"),
      },
    ];

    const result = await attachDroppedResourcesToCodex([
      vscode.Uri.parse(
        "vscode-remote://ssh-remote%2Bdev/home/unitree/project/src/main.py",
      ),
      vscode.Uri.parse("vscode-remote://ssh-remote%2Bdev/home/unitree/other.py"),
    ]);

    expect(mock.executeCommand).toHaveBeenCalledTimes(1);
    expect((mock.executeCommand.mock.calls[0]?.[1] as vscodeTypes.Uri).fsPath).toBe(
      "/home/unitree/project/src/main.py",
    );
    expect(result).toMatchObject({
      attachedCount: 1,
      failedCount: 1,
      localCount: 0,
      remoteCount: 1,
    });
    expect(result.firstFailure).toContain("outside the active Remote SSH workspace");
  });

  it("fails closed when the official native context command is unavailable", async () => {
    mock.commandIds = [];

    await expect(
      attachDroppedResourcesToCodex([vscode.Uri.file("/work/main.py")]),
    ).rejects.toThrow("does not expose its native file context command");
    expect(mock.executeCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed renderer payloads before parsing paths", () => {
    expect(() =>
      extractWorkbenchDropPayloadUris({ schemaVersion: 1, nativeFilePaths: [42] }),
    ).toThrow("non-empty strings");
    expect(() => extractWorkbenchDropPayloadUris({ schemaVersion: 2 })).toThrow(
      "Unsupported Workbench drop payload schema",
    );
  });

});
