# 实施状态

更新日期：2026-07-16

## 阶段 A：协议与运行位置探针

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 入口 | 已实现配置、备份和恢复 | `OfficialSettingsManager` |
| Remote SSH 自动配置与启动 | 已实现；首次设置变更自动重载一次 | `BridgeController.initialize` |
| 本地窗口隔离 | 已实现；无 Remote SSH 会话标记时 Shim 完全透传 | `activeBridgeConfigPath` |
| 本地 Codex 常见路径探测 | 已实现并测试 | `codexExecutableCandidates` |
| 强制官方扩展使用本地 UI Host | 已在 xj-member 确认 Shim 和 app-server 为本地进程 | `code --status` |
| Codex Webview 位置恢复 | 每工作区首次就绪时仅重置 Codex 视图 | `repairCodexViewLocation` |
| app-server `initialize` 代理 | 已按官方前置全局参数通过真实 app-server 冒烟测试 | `npm run smoke:shim` |
| `thread/start` 路径和能力注入 | 已实现并通过集成测试 | `rewriteClientMessage` |
| `permissions`/`sandbox` 互斥 | 移除客户端权限档案并固定本地只读 sandbox | `rewriteClientMessage` |
| `thread/resume` 本地控制目录固定 | 已实现并通过单元测试覆盖相同重写路径 | `rewriteClientMessage` |
| 远端无 Codex | 诊断已实现，待目标主机验收 | `Run Diagnostics` |

阶段 A 退出条件尚未完全满足：还需要在真实 Remote SSH 窗口使用官方界面完成一次
不访问项目的对话，并记录官方扩展实际运行位置。

## 阶段 B：远程只读

| 项目 | 状态 |
| --- | --- |
| 单 SSH 主机和单工作区配置 | 已实现 |
| 远程身份、主机名、machine-id、根目录探针 | 已在 xj-member 真实主机验证 |
| 文件读取和 SHA-256 元数据 | 已在 MimicLite 验证 |
| 目录列出 | 已在 MimicLite 验证 |
| 远端 `rg --json` 搜索 | 已实现；目标主机无 `rg` 时的 `grep` 回退已验证 |
| 只读 `git status` | 已在 MimicLite 验证 |
| 词法路径限制 | 已实现并测试 |
| 远端 `realpath` 与符号链接防逃逸 | 已用仓库内指向 `/root/.local` 的真实符号链接验证 |
| 独立本地审计日志和脱敏 | 已实现并测试 |
| 远程 URI、Diff 和文件跳转 | 未实现 |

阶段 B 的执行器与 Shim 动态只读工具已通过真实 SSH 验收。尚缺 VS Code 当前文件、
远程链接和本地同名诱饵文件的界面侧验收，因此阶段 B 仍未整体关闭。

## 阶段 C/D

远程写入、补丁、通用命令、审批绑定、幂等、连接恢复、VSIX 日常使用验证均未进入
完成状态。代码中不注入这些动态工具，因此模型无法把未实现能力误当成可用能力。
