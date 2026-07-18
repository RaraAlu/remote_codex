# VS Code Remote 通用 stdio MCP 验收

日期：2026-07-18

## 环境

- 本地：Windows x64，VS Code `1.129.1`
- 官方扩展：`openai.chatgpt@26.707.91948`
- Bridge Controller：`0.2.6`
- Remote Executor：`0.2.5`，协议 v3
- 连接模式：`vscode-remote`
- 目标：`xj-member-42013:/root/work/train/MimicLite`

## 验收结果

- 重载 Remote SSH 窗口后，Controller 会话包含有效的 VS Code transport 描述符，状态
  恢复为 `ready`。
- Shim 审计记录 `remoteMcpServers=["codegraph"]`，并把本机 MCP command 覆盖为当前
  Bridge Shim 的 `mcp-proxy` 子命令；`node_repl` 等不符合远端路由条件的服务仍在本机。
- 直接通过本地 relay 发起 MCP `initialize` 和 `tools/list` 成功，远端返回
  `codegraph_explore`。
- 继续发送 `tools/call`，调用 `codegraph_explore` 查询 `command.py` 成功；响应来自
  `/root/work/train/MimicLite` 的远端索引，返回 17 个符号、3 个文件且 `isError=false`。
- 全程没有建立第二条 OpenSSH 连接，也没有向远端复制 SSH 密码、OpenAI Token 或本机
  MCP 环境变量。

## 通用性边界

CodeGraph 仅作为真实服务样例。传输层按原始 stdin/stdout/stderr 字节流工作，不依赖
CodeGraph 协议；所有通过相同安全筛选、且远端存在同名直接可执行文件的 stdio MCP
都使用同一 relay、窗口 IPC、VS Code 命令通道和 Remote Executor 会话实现。
