import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { projectServerMessage } from "../src/shim/native-tool-presentation.js";

const config = parseBridgeConfig({
  host: "training-gpu",
  workspaceRoot: "/remote/workspace",
});

describe("native Codex tool presentation", () => {
  it("projects a remote file read into the native command execution shape", () => {
    const projected = projectServerMessage(
      {
        method: "item/started",
        params: {
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "remote_read_file",
            arguments: { path: "src/index.ts" },
            status: "inProgress",
            success: null,
          },
        },
      },
      config,
    ) as unknown as {
      params: {
        item: {
          type: string;
          cwd: string;
          status: string;
          commandActions: Array<Record<string, unknown>>;
        };
      };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      cwd: "/remote/workspace",
      status: "inProgress",
      commandActions: [
        {
          type: "read",
          name: "index.ts",
          path: "/remote/workspace/src/index.ts",
        },
      ],
    });
  });

  it("projects bounded tree output as one completed native list-files action", () => {
    const projected = projectServerMessage(
      {
        method: "item/completed",
        params: {
          item: {
            id: "item-2",
            type: "dynamicToolCall",
            tool: "remote_list_tree",
            arguments: { path: ".", depth: 2 },
            status: "completed",
            success: true,
            durationMs: 12,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  ok: true,
                  data: {
                    entries: [
                      { path: "src", type: "directory" },
                      { path: "src/index.ts", type: "file" },
                    ],
                    truncated: false,
                  },
                }),
              },
            ],
          },
        },
      },
      config,
    ) as unknown as {
      params: {
        item: {
          type: string;
          status: string;
          aggregatedOutput: string;
          commandActions: Array<Record<string, unknown>>;
        };
      };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      status: "completed",
      aggregatedOutput: "src/\nsrc/index.ts",
      commandActions: [
        {
          type: "listFiles",
          path: "/remote/workspace",
        },
      ],
    });
  });

  it("projects persisted remote tool items nested in thread responses", () => {
    const projected = projectServerMessage(
      {
        id: 9,
        result: {
          thread: {
            turns: [
              {
                items: [
                  {
                    id: "item-3",
                    type: "dynamicToolCall",
                    tool: "remote_git_status",
                    arguments: {},
                    status: "completed",
                    success: false,
                    contentItems: [
                      {
                        type: "inputText",
                        text: JSON.stringify({
                          ok: false,
                          error: { message: "SSH disconnected" },
                        }),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      config,
    ) as unknown as {
      result: {
        thread: {
          turns: Array<{
            items: Array<Record<string, unknown>>;
          }>;
        };
      };
    };

    expect(projected.result.thread.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      command: "git status --short --branch",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "SSH disconnected",
    });
  });

  it("uses the approved remote command cwd in native command items", () => {
    const projected = projectServerMessage(
      {
        method: "item/started",
        params: {
          item: {
            id: "item-exec",
            type: "dynamicToolCall",
            tool: "remote_exec",
            arguments: {
              argv: ["env"],
              cwd: "scripts",
              env: { MODE: "test" },
            },
            status: "inProgress",
          },
        },
      },
      config,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      command: "env MODE=test env",
      cwd: "/remote/workspace/scripts",
    });
  });

  it("leaves unrelated dynamic tools and local passthrough messages untouched", () => {
    const message = {
      item: {
        id: "item-4",
        type: "dynamicToolCall",
        tool: "codex_app",
        arguments: {},
        status: "completed",
      },
    };
    expect(projectServerMessage(message, config)).toBe(message);
    expect(projectServerMessage(message, null)).toBe(message);
  });
});
