import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  closeVsCodeConversationClients,
  interruptVsCodeConversation,
  interveneVsCodeConversation,
  listVsCodeConversations,
  readVsCodeConversation,
} from "./vscode-conversation-client.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export async function runExternalMcpServer(): Promise<number> {
  const server = new McpServer({
    name: "codex-vscode-remote-bridge",
    version: "0.3.1",
  });

  server.registerTool(
    "vscode_codex_list_conversations",
    {
      title: "列出 VS Code Codex 对话",
      description:
        "列出当前 Codex Remote Bridge 插件所管理的活动 VS Code Codex 会话和对话。",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => textResult(await listVsCodeConversations(limit)),
  );

  server.registerTool(
    "vscode_codex_read_conversation",
    {
      title: "读取 VS Code Codex 对话",
      description:
        "读取指定 VS Code Codex thread 的最近 turn 和完整 item，用于持续观察和自测。",
      inputSchema: {
        threadId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(20),
        sessionPid: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ threadId, limit, sessionPid }) =>
      textResult(await readVsCodeConversation(threadId, limit, sessionPid)),
  );

  server.registerTool(
    "vscode_codex_intervene",
    {
      title: "介入 VS Code Codex 对话",
      description:
        "向指定 VS Code Codex thread 写入消息。auto 会在有活动 turn 时 steer，否则启动新 turn。",
      inputSchema: {
        threadId: z.string().uuid(),
        text: z.string().min(1),
        mode: z.enum(["auto", "steer", "new-turn"]).default("auto"),
        expectedTurnId: z.string().uuid().optional(),
        sessionPid: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ threadId, text, mode, expectedTurnId, sessionPid }) =>
      textResult(
        await interveneVsCodeConversation({
          threadId,
          text,
          mode,
          expectedTurnId,
          sessionPid,
        }),
      ),
  );

  server.registerTool(
    "vscode_codex_interrupt",
    {
      title: "取消 VS Code Codex Turn",
      description: "取消指定 VS Code Codex thread 中仍在运行的 turn。",
      inputSchema: {
        threadId: z.string().uuid(),
        turnId: z.string().uuid(),
        sessionPid: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ threadId, turnId, sessionPid }) =>
      textResult(
        await interruptVsCodeConversation({ threadId, turnId, sessionPid }),
      ),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return await new Promise<number>((resolvePromise) => {
    process.stdin.once("end", () => {
      closeVsCodeConversationClients();
      void server.close().finally(() => resolvePromise(0));
    });
  });
}
