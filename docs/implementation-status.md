# 实施状态

更新日期：2026-07-16

## 阶段 A：协议与运行位置探针

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 入口 | 已实现配置、备份和恢复 | `OfficialSettingsManager` |
| 强制官方扩展使用本地 UI Host | 已实现设置写入，待真实 Remote SSH 窗口确认 | `remote.extensionKind.openai.chatgpt=["ui"]` |
| app-server `initialize` 代理 | 已通过真实 app-server 冒烟测试 | `npm run smoke:shim` |
| `thread/start` 路径和能力注入 | 已实现并通过集成测试 | `rewriteClientMessage` |
| `thread/resume` 本地控制目录固定 | 已实现并通过单元测试覆盖相同重写路径 | `rewriteClientMessage` |
| 远端无 Codex | 诊断已实现，待目标主机验收 | `Run Diagnostics` |

阶段 A 退出条件尚未完全满足：还需要在真实 Remote SSH 窗口使用官方界面完成一次
不访问项目的对话，并记录官方扩展实际运行位置。

## 阶段 B：远程只读

| 项目 | 状态 |
| --- | --- |
| 单 SSH 主机和单工作区配置 | 已实现 |
| 远程身份、主机名、machine-id、根目录探针 | 已实现 |
| 文件读取和 SHA-256 元数据 | 已实现 |
| 目录列出 | 已实现 |
| 远端 `rg --json` 搜索 | 已实现 |
| 只读 `git status` | 已实现 |
| 词法路径限制 | 已实现并测试 |
| 远端 `realpath` 与符号链接防逃逸 | 已实现，待真实主机集成测试 |
| 独立本地审计日志和脱敏 | 已实现并测试 |
| 远程 URI、Diff 和文件跳转 | 未实现 |

阶段 B 退出条件尚未满足：需要在 MimicLite 上完成真实 SSH 读取、搜索、诱饵文件和
符号链接逃逸测试。

## 阶段 C/D

远程写入、补丁、通用命令、审批绑定、幂等、连接恢复、VSIX 日常使用验证均未进入
完成状态。代码中不注入这些动态工具，因此模型无法把未实现能力误当成可用能力。
