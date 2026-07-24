import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/core/audit-log.js";
import { parseBridgeConfig } from "../src/core/config.js";
import type { OpenSshExecutor } from "../src/core/ssh-executor.js";
import {
  DynamicToolRouter,
  REMOTE_DYNAMIC_TOOLS,
} from "../src/shim/dynamic-tools.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function parseResult(response: unknown): Record<string, unknown> {
  const value = response as { contentItems?: Array<{ text?: string }> };
  return JSON.parse(value.contentItems?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function config() {
  return parseBridgeConfig({
    version: 2,
    host: "test_40",
    roots: [
      {
        displayName: "Zklab",
        id: "remote-primary",
        path: "/home/zkbot/work/train/zklab/Zklab",
        role: "primary",
        target: "remote",
      },
    ],
  });
}

async function router(executor: OpenSshExecutor): Promise<{
  auditPath: string;
  router: DynamicToolRouter;
}> {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-resource-tools-"));
  directories.push(directory);
  const auditPath = join(directory, "audit.jsonl");
  return {
    auditPath,
    router: new DynamicToolRouter(config(), executor, new AuditLog(auditPath)),
  };
}

describe("workspace resource dynamic tools", () => {
  it("publishes bounded open and Diff schemas", () => {
    expect(
      REMOTE_DYNAMIC_TOOLS.find((tool) => tool.name === "workspace_open_file"),
    ).toMatchObject({
      inputSchema: {
        required: ["path"],
        properties: {
          line: { minimum: 1 },
          path: { type: "string" },
        },
      },
    });
    expect(
      REMOTE_DYNAMIC_TOOLS.find((tool) => tool.name === "workspace_show_diff"),
    ).toMatchObject({
      inputSchema: {
        required: ["path", "beforeContentBase64", "beforeHash"],
        properties: {
          beforeHash: { pattern: "^[0-9a-f]{64}$" },
        },
      },
    });
  });

  it("canonicalizes a remote file before asking the Controller to open it", async () => {
    const canonicalPath = vi.fn(async () => `${config().workspaceRoot}/src/main.py`);
    const requestControllerWorkspace = vi.fn(async () => ({
      action: "opened",
      relativePath: "src/main.py",
      resourceUri:
        "codex-bridge://workspace/remote-primary/src/main.py?host=test_40&target=remote",
      workspaceUri:
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/src/main.py",
    }));
    const { router: toolRouter } = await router({
      canonicalPath,
      connectionId: "conn-resource",
      requestControllerWorkspace,
    } as unknown as OpenSshExecutor);

    const response = await toolRouter.handle(1, {
      arguments: { column: 2, line: 7, path: "src/main.py" },
      callId: "open-1",
      tool: "workspace_open_file",
    });

    expect(parseResult(response)).toMatchObject({
      ok: true,
      data: {
        action: "opened",
        resourceUri: expect.stringContaining("codex-bridge://workspace/"),
      },
    });
    expect(canonicalPath).toHaveBeenCalledWith("src/main.py");
    expect(requestControllerWorkspace).toHaveBeenCalledWith(
      "openWorkspaceResource",
      "remote-primary",
      {
        column: 2,
        line: 7,
        path: `${config().workspaceRoot}/src/main.py`,
      },
    );
  });

  it("does not write a Diff snapshot body to the audit log", async () => {
    const snapshot = Buffer.from("before\n").toString("base64");
    const requestControllerWorkspace = vi.fn(async () => ({
      action: "diffed",
      relativePath: "src/main.py",
      resourceUri:
        "codex-bridge://workspace/remote-primary/src/main.py?host=test_40&target=remote",
      workspaceUri:
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/src/main.py",
    }));
    const { auditPath, router: toolRouter } = await router({
      canonicalPath: vi.fn(async () => `${config().workspaceRoot}/src/main.py`),
      connectionId: "conn-resource",
      requestControllerWorkspace,
    } as unknown as OpenSshExecutor);

    const response = await toolRouter.handle(2, {
      arguments: {
        beforeContentBase64: snapshot,
        beforeHash: "a".repeat(64),
        path: "src/main.py",
        title: "Review",
      },
      callId: "diff-1",
      tool: "workspace_show_diff",
    });

    expect(response).toMatchObject({ success: true });
    expect(requestControllerWorkspace).toHaveBeenCalledWith(
      "showWorkspaceDiff",
      "remote-primary",
      {
        beforeContentBase64: snapshot,
        beforeHash: "a".repeat(64),
        path: `${config().workspaceRoot}/src/main.py`,
        title: "Review",
      },
    );
    const audit = await readFile(auditPath, "utf8");
    expect(audit).not.toContain(snapshot);
    expect(audit).toContain(`"beforeHash":"${"a".repeat(64)}"`);
  });

  it("fails closed in OpenSSH mode because no editor transport exists", async () => {
    const { router: toolRouter } = await router({
      canonicalPath: vi.fn(async () => `${config().workspaceRoot}/src/main.py`),
      connectionId: "conn-openssh",
    } as unknown as OpenSshExecutor);

    const response = await toolRouter.handle(3, {
      arguments: { path: "src/main.py" },
      callId: "open-denied",
      tool: "workspace_open_file",
    });

    expect(parseResult(response)).toMatchObject({
      error: { code: "COMMAND_DENIED" },
      ok: false,
    });
  });

  it("adds a stable resource URI to ordinary workspace file reads", async () => {
    const requestControllerWorkspace = vi.fn(async () => ({
      action: "registered",
      resourceUri:
        "codex-bridge://workspace/remote-primary/README.md?host=test_40&target=remote",
      workspaceUri:
        "vscode-remote://ssh-remote%2Btest_40/home/zkbot/work/train/zklab/Zklab/README.md",
    }));
    const { router: toolRouter } = await router({
      connectionId: "conn-read",
      readFile: vi.fn(async () => ({
        canonicalPath: `${config().workspaceRoot}/README.md`,
        contentBase64: "cmVhZG1l",
        hash: "b".repeat(64),
        mode: "81a4",
        modifiedAtMs: 1,
        size: 6,
        truncated: false,
      })),
      requestControllerWorkspace,
    } as unknown as OpenSshExecutor);

    const response = await toolRouter.handle(4, {
      arguments: { path: "README.md" },
      callId: "read-resource",
      tool: "workspace_read_file",
    });

    expect(parseResult(response)).toMatchObject({
      data: {
        resourceUri:
          "codex-bridge://workspace/remote-primary/README.md?host=test_40&target=remote",
      },
      ok: true,
    });
    expect(requestControllerWorkspace).toHaveBeenCalledWith(
      "registerWorkspaceResource",
      "remote-primary",
      { path: `${config().workspaceRoot}/README.md` },
    );
  });
});
