import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "../src/core/config.js";
import { projectServerMessage } from "../src/shim/native-tool-presentation.js";

const config = parseBridgeConfig({
  host: "training-gpu",
  workspaceRoot: "/remote/workspace",
});

const dualConfig = parseBridgeConfig({
  version: 2,
  host: "training-gpu",
  roots: [
    {
      id: "remote-primary",
      target: "remote",
      role: "primary",
      path: "/remote/workspace",
      displayName: "Remote workspace",
    },
    {
      id: "local-reference",
      target: "local",
      role: "secondary",
      path: "/local/reference",
      displayName: "Local reference",
    },
  ],
});

describe("native Codex tool presentation", () => {
  it("does not project a remote POSIX path as a local native file action", () => {
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
          type: "unknown",
        },
      ],
    });
  });

  it("projects an authorized local read with its local root identity and cwd", () => {
    const projected = projectServerMessage(
      {
        method: "item/started",
        params: {
          item: {
            id: "item-local",
            type: "dynamicToolCall",
            tool: "workspace_read_file",
            arguments: {
              path: "notes.md",
              rootId: "local-reference",
              target: "local",
            },
            status: "inProgress",
          },
        },
      },
      dualConfig,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      command:
        "codex-bridge read --target local --root 'local-reference' -- '/local/reference/notes.md'",
      cwd: "/local/reference",
      commandActions: [
        {
          type: "read",
          name: "notes.md",
          path: "/local/reference/notes.md",
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
          type: "unknown",
        },
      ],
    });
  });

  it("projects editor open results with their stable resource URI", () => {
    const resourceUri =
      "codex-bridge://workspace/remote-primary/src/index.ts?host=training-gpu&target=remote";
    const projected = projectServerMessage(
      {
        method: "item/completed",
        params: {
          item: {
            id: "item-open",
            type: "dynamicToolCall",
            tool: "workspace_open_file",
            arguments: { path: "src/index.ts" },
            status: "completed",
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  ok: true,
                  data: {
                    action: "opened",
                    relativePath: "src/index.ts",
                    resourceUri,
                  },
                }),
              },
            ],
          },
        },
      },
      config,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };

    expect(projected.params.item).toMatchObject({
      aggregatedOutput: `Resource: ${resourceUri}\nopened: src/index.ts`,
      command:
        "codex-bridge open --target remote --root 'remote-primary' -- '/remote/workspace/src/index.ts'",
      commandActions: [{ type: "unknown" }],
      status: "completed",
      type: "commandExecution",
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
      command: "codex-bridge status --target remote --root 'remote-primary'",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "SSH disconnected",
    });
  });

  it("fails a lingering remote tool item when its persisted turn was interrupted", () => {
    const projected = projectServerMessage(
      {
        result: {
          thread: {
            turns: [
              {
                id: "turn-interrupted",
                status: "interrupted",
                items: [
                  {
                    id: "item-interrupted",
                    type: "dynamicToolCall",
                    tool: "remote_exec",
                    arguments: { argv: ["sleep", "120"] },
                    status: "inProgress",
                    success: null,
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
      command: "sleep 120",
      status: "failed",
      exitCode: null,
      aggregatedOutput: "Command stopped when the turn was interrupted.",
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

  it("projects background task launch and cursor logs as native command items", () => {
    const started = projectServerMessage(
      {
        method: "item/started",
        params: {
          item: {
            id: "item-background",
            type: "dynamicToolCall",
            tool: "remote_background_start",
            arguments: {
              argv: ["npm", "run", "check"],
              cwd: "packages/core",
            },
            status: "inProgress",
          },
        },
      },
      config,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };
    expect(started.params.item).toMatchObject({
      command: "codex-bridge background start -- npm run check",
      cwd: "/remote/workspace/packages/core",
      status: "inProgress",
      type: "commandExecution",
    });

    const logged = projectServerMessage(
      {
        method: "item/completed",
        params: {
          item: {
            id: "item-background-log",
            type: "dynamicToolCall",
            tool: "remote_background_log",
            arguments: { taskId: "bg_test", cursor: 0 },
            status: "completed",
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  ok: true,
                  data: {
                    task: { taskId: "bg_test", status: "running" },
                    events: [
                      {
                        channel: "stdout",
                        contentBase64: Buffer.from("out\n").toString("base64"),
                        cursor: 0,
                      },
                      {
                        channel: "stderr",
                        contentBase64: Buffer.from("err\n").toString("base64"),
                        cursor: 4,
                      },
                    ],
                    nextCursor: 8,
                    truncated: true,
                    hasMore: false,
                  },
                }),
              },
            ],
          },
        },
      },
      config,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };
    expect(logged.params.item).toMatchObject({
      aggregatedOutput: "[earlier output truncated]\nout\n[stderr] err\n",
      command: "codex-bridge background log 'bg_test'",
      status: "completed",
      type: "commandExecution",
    });
  });

  it("preserves a nonzero remote command exit code in the native item", () => {
    const projected = projectServerMessage(
      {
        method: "item/completed",
        params: {
          item: {
            id: "item-failed-exec",
            type: "dynamicToolCall",
            tool: "remote_exec",
            arguments: {
              argv: ["git", "status", "--short"],
            },
            status: "completed",
            success: true,
            durationMs: 73,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  ok: true,
                  data: {
                    actualCwd: "/remote/workspace",
                    durationMs: 73,
                    exitCode: 128,
                    signal: null,
                    stdout: "",
                    stderr: "fatal: not a git repository\n",
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
      params: { item: Record<string, unknown> };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      status: "failed",
      exitCode: 128,
      aggregatedOutput: "fatal: not a git repository\n",
    });
  });

  it("reads a failed command exit code from structured error details", () => {
    const projected = projectServerMessage(
      {
        method: "item/completed",
        params: {
          item: {
            id: "item-failed-git",
            type: "dynamicToolCall",
            tool: "remote_git_status",
            arguments: {},
            status: "failed",
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  ok: false,
                  error: {
                    message: "git status failed",
                    details: {
                      exitCode: 128,
                      signal: null,
                    },
                  },
                }),
              },
            ],
          },
        },
      },
      config,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      status: "failed",
      exitCode: 128,
      aggregatedOutput: "git status failed",
    });
  });

  it("preserves a signal termination with a null exit code", () => {
    const projected = projectServerMessage(
      {
        method: "item/completed",
        params: {
          item: {
            id: "item-signalled-exec",
            type: "dynamicToolCall",
            tool: "remote_exec",
            arguments: {
              argv: ["sleep", "10"],
            },
            status: "completed",
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  ok: true,
                  data: {
                    exitCode: null,
                    signal: "SIGTERM",
                    stdout: "",
                    stderr: "",
                  },
                }),
              },
            ],
          },
        },
      },
      config,
    ) as unknown as {
      params: { item: Record<string, unknown> };
    };

    expect(projected.params.item).toMatchObject({
      type: "commandExecution",
      status: "failed",
      exitCode: null,
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
