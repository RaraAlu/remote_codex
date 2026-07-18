# 实施状态

更新日期：2026-07-18

## 阶段 A：协议与运行位置探针

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 入口 | 已实现配置、备份和恢复 | `OfficialSettingsManager` |
| Remote SSH 自动配置与启动 | 已实现；首次设置变更自动重载一次 | `BridgeController.initialize` |
| 本地窗口隔离 | 已实现；无 Remote SSH 会话标记时 Shim 完全透传 | `activeBridgeConfigPath` |
| 本地 Codex 常见路径探测 | 已按 Windows/Linux 平台实现并测试 | `codexExecutableCandidates` |
| Windows 原生 Shim | Node SEA `codex-bridge-shim.exe` 已构建并通过真实 Codex 冒烟 | `scripts/build.mjs` |
| 双平台发布 | 同一扩展 ID 分别生成 `win32-x64` 和 `linux-x64` VSIX | `scripts/package.mjs` |
| VS Code Remote 通道 | 已实现本机 IPC、远端 Workspace Executor 和内嵌 VSIX 自动部署；真实 Remote SSH 窗口只读回环已通过 | `VsCodeTransportServer` / `LocalProcessExecutor` |
| 密码/密钥认证复用 | `vscode-remote` 模式不新建 SSH，复用当前 Remote SSH 窗口认证 | `codexRemoteBridge.connectionMode` |
| 稳定启动器安装 | 已安装到版本与内容哈希隔离的本地状态目录 | `installBridgeShim` |
| 跨平台旧路径迁移 | 已识别 Bridge 旧版/异平台遗留路径，不把无效路径备份为用户原值 | `OfficialSettingsManager` |
| 本地 OpenSSH 探测 | Windows 系统 OpenSSH、显式配置和 Linux 命令名均已覆盖 | `sshExecutableCandidates` |
| 强制官方扩展使用本地 UI Host | 已在 xj-member 确认 Shim 和 app-server 为本地进程 | `code --status` |
| Codex Webview 位置恢复 | 每工作区首次就绪时仅重置 Codex 视图 | `repairCodexViewLocation` |
| app-server `initialize` 代理 | 已按官方前置全局参数通过真实 app-server 冒烟测试 | `npm run smoke:shim` |
| `thread/start` 路径和能力注入 | 已实现并通过集成测试 | `rewriteClientMessage` |
| `permissions`/`sandbox` 互斥 | 移除客户端权限档案并固定本地只读 sandbox | `rewriteClientMessage` |
| `thread/resume` 本地控制目录固定 | 已实现并通过单元测试覆盖相同重写路径 | `rewriteClientMessage` |
| 远端无 Codex | 诊断已实现；xj-member 目标已确认未安装 Codex | `Run Diagnostics` / 2026-07-16 验收 |

阶段 A 退出条件尚未完全满足：还需要在真实 Remote SSH 窗口使用官方界面完成一次
不访问项目的对话，并记录官方扩展实际运行位置。

## 阶段 B：远程只读

| 项目 | 状态 |
| --- | --- |
| 单 SSH 主机和单工作区配置 | 已实现 |
| 远程身份、主机名、machine-id、根目录探针 | 已在 xj-member 真实主机验证 |
| 文件读取和 SHA-256 元数据 | 已在 MimicLite 验证 |
| 目录列出 | 已在 MimicLite 验证 |
| 有界目录树 | 已实现并通过执行器测试；减少项目概览的重复单层列目录调用 |
| 远端 `rg --json` 搜索 | 已实现；目标主机无 `rg` 时的 `grep` 回退已验证 |
| 只读 `git status` | 已在 MimicLite 验证 |
| 词法路径限制 | 已实现并测试 |
| 远端 `realpath` 与符号链接防逃逸 | 已用仓库内指向 `/root/.local` 的真实符号链接验证 |
| 独立本地审计日志和脱敏 | 已实现并测试 |
| Bridge 工具原生界面投影 | 已实现并测试；当前支持组合仍缺独立的真实窗口界面观感证据 |
| 远程 URI、Diff 和文件跳转 | 未实现 |

阶段 B 的执行器与 Shim 动态只读工具已通过真实 SSH 验收。尚缺 VS Code 当前文件、
远程链接和本地同名诱饵文件的界面侧验收，因此阶段 B 仍未整体关闭。

## 阶段 C：远程命令与写入

| 项目 | 状态 |
| --- | --- |
| 结构化 `argv` 非交互命令 | 已实现；默认通过 Remote Extension Host，OpenSSH 为回退 |
| 官方命令审批 | 已实现；非完全访问模式显示主机、规范化 `cwd`、完整命令和环境变更 |
| 命令输出流 | 已映射为 `item/commandExecution/outputDelta` |
| 权限模式继承 | 已按线程映射 `full-access`/`approvalPolicy=never`，其余模式失败关闭 |
| 审批绑定 | 人工审批仅匹配一个待处理调用 ID；完全访问的自动放行单独审计 |
| 运行中取消 | 未实现 |
| 哈希保护写入和补丁 | 未实现 |
| 断线结果确认和幂等 | 未实现 |
| Core 内置本地工具硬阻断 | 未实现 |

阶段 C 尚未关闭。0.2.0 提供与官方权限模式一致的远程命令执行；写操作、取消、断线恢复
和本地执行硬阻断完成前，不得用于无人值守的有副作用任务。

## 升级与发布跟踪

发布门禁、升级触发矩阵、量化回归规则和 Windows/Linux 分平台要求已统一写入
`docs/upgrade-tracking.md`，候选版本使用 `docs/acceptance/release-template.md` 保存独立
证据。0.2.7 首份基线位于 `docs/acceptance/2026-07-18-release-0.2.7.md`：Windows x64
Controller 到远端 Ubuntu Executor 的主链路已通过；Linux x64 Controller 仅完成打包和
内容核对，本地 Extension Host、CJS Shim、官方任务及 Remote SSH 运行时仍为待补测。

## 本地 MCP 边界

远程工作区任务仍可使用本地 Codex app-server 原有的 MCP、App 和 Connector 服务，
Bridge 不会移除这些服务。Remote SSH 窗口会扫描本机 MCP，并把无凭据、无本地工作
目录、非包管理器启动且远端存在同名可执行文件的 stdio 服务通过当前 Bridge 目标启动；
默认 `vscode-remote` 模式使用本地 relay 和 Remote Executor 长生命周期子进程转发原始
stdin/stdout/stderr，复用当前 VS Code Remote SSH 连接；`openssh` 回退模式继续使用 SSH
stdio 中转。该传输不依赖 CodeGraph，可用于所有通过同一安全策略的直接 stdio MCP。
本地 relay 通过显式 `--session-config` 路径加载窗口 transport，避免 Codex Core 清理
`CODEX_BRIDGE_*` 环境变量后丢失会话；文件内随机令牌不会出现在命令行中。
其余服务继续留在本机。`remoteMcpAccess=enabled` 保留已有启用和审批策略；
`remoteMcpAccess=all` 为当前 app-server 尝试启用已配置服务、清空工具禁用列表并
设置默认工具审批为 `approve`。覆盖会由同版本 Codex 校验；会替换插件层 transport
的不兼容服务保持原配置。所有覆盖仅作用于当前 app-server，不写入全局 Codex 配置。
CodeGraph 保留独立的工作区根目录参数适配；它是通用 stdio 通道的验收样例，而不是
通道实现中的特殊传输分支。
