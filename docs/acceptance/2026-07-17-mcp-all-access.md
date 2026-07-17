# MCP 全部访问模式验收

日期：2026-07-17

目标：

- 本地 Codex CLI/app-server 保持为 `0.144.5`。
- Remote SSH 目标为 `bitahub:/root/work/train/MimicLite`。
- Bridge 仅对当前远程窗口启用全部已配置 MCP 和默认工具批准。
- CodeGraph 继续通过 SSH 使用远程工作区索引。

## 自动化结果

- `npm run check`：75 个测试通过，5 个真实远端测试按设计跳过；类型检查、构建、
  Shim 冒烟和 VSIX 打包通过。
- 真实远端套件：5 个测试全部通过，包括远程身份、文件、Git、GPU、路径拒绝、
  动态工具、命令审批、完全访问和 CodeGraph MCP 调用。
- `remoteMcpAccess=all` 测试确认 `blender` 与 `codegraph` 都注入
  `enabled=true`、`disabled_tools=[]` 和
  `default_tools_approval_mode="approve"`。
- CodeGraph 被路由为 SSH stdio，并成功查询远程索引；Blender 的本地启动器和环境
  配置没有复制到远端。

## 运行态结果

- 已安装 `zkbot.codex-vscode-remote-bridge@0.1.11`。
- 用户设置已切换为 `codexRemoteBridge.remoteMcpAccess=all`。
- 完整重启 VS Code 后，MimicLite 窗口状态为 `ready`。
- 运行中 app-server 参数包含两个 MCP 的全部访问覆盖，以及 CodeGraph 的 SSH
  `command`/`args` 覆盖。
- 最新审计事件记录 `remoteMcpAccess=all`、`localMcpServers=["blender"]` 和
  `remoteMcpServers=["codegraph"]`。

该模式只开放服务实际注册且未被上层 allowlist 或托管策略限制的工具，不生成
CodeGraph 1.4.1 未提供的 `status`、`files` 等工具。
