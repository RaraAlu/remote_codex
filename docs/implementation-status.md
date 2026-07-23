# 实施状态

更新日期：2026-07-22

## 能力边界复核

2026-07-22 已重新汇总全部待实现、待验证和待补测项，并核查当前源码、`0.144.5` 与
`0.145.0` 协议差异、Linux x64 自动化、活动 Remote SSH transport、Codex 日志和 Bridge
审计。详细边界、依赖顺序、分阶段实施内容与验收条件见
`docs/capability-boundary-plan.md`。

同日先完成外部稳定版 `0.145.0` 协议探针，随后按用户确认的边界将官方
`openai.chatgpt` 扩展设为唯一运行时权威。当前源码只启动 VS Code 实际加载的
`openai.chatgpt` 所内置的 Codex，实测组合为 `26.715.61943` /
`0.145.0-alpha.27`。源码删除公开
`codexExecutable` 设置、系统 CLI 发现和 PATH/`~/.local/bin` 回退；旧配置中的该字段
会被忽略。官方扩展版本只用于诊断和证据，不固定为启动门禁；Controller 保存经过
内置 app-server 协议校验的受限运行时指针，Shim 自身再次校验后才透传或代理。

当前协议位于 `protocol/0.145.0-alpha.27/`，由插件内置二进制生成，并包含
`ClientRequest`、线程设置更新、fork 和 turn 等 Bridge 依赖结构。`npm run check`
为 33 个测试文件通过、1 个真实远端条件文件跳过，139 项通过、5 项跳过、0 失败；
插件内置 app-server 的本地透传、远程窗口启动、线程创建、本地拒绝权限配置激活、
主次根审计冒烟和 Linux x64 打包通过。系统 Codex CLI 的存在、缺失或版本不再影响
这些路径。

当前仍是候选状态：用户已重载活动 Remote SSH 窗口，进程和运行时指针确认目标窗口只
使用官方插件内置 Codex，Bridge 对规范化远端根进入 `ready`，已有会话恢复成功。
阶段 2B 已通过官方 app-server 参数探针，并用新候选 Shim 复用活动 VS Code transport
完成 `remote_exec(["pwd"])` 回环；线程和 turn 都收到唯一远程主根，原有上下文未被
覆盖，审计明确区分远程主根和本地控制目录。阶段 2C 已在候选 Shim 阻断 25 个已知
本地客户端请求和五类 Core 本地审批，官方 app-server 实际激活
`codex-remote-bridge` 权限配置，活动
transport 的远程 `pwd` 仍通过。真实模型的本地诱饵读写执行、官方 UI 新建/恢复、
附件、当前文件和本地窗口透传仍待补测。Linux 构建无法生成 Windows SEA Shim，
双平台产物收集仍为待实施项。

## 阶段 A：协议与运行位置探针

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 入口 | 已实现配置、备份和恢复 | `OfficialSettingsManager` |
| Remote SSH 自动配置与启动 | 已实现；首次设置变更自动重载一次 | `BridgeController.initialize` |
| 本地窗口隔离 | 已实现；无 Remote SSH 会话标记时 Shim 完全透传 | `activeBridgeConfigPath` |
| 官方扩展内置运行时 | 只接受当前官方扩展目录中的平台二进制；系统 CLI 不参与 | `resolveOfficialCodexExecutable` |
| 内置协议门禁 | Controller 与 Shim 校验插件内置 app-server 与生成协议；不固定插件版本 | `validateBundledCodexProtocol` |
| 旧 CLI 配置迁移 | 已删除公开设置；旧配置字段被解析器忽略 | `parseBridgeConfig` |
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
| `thread/start` 路径和能力注入 | 本地进程 `cwd` 与远程逻辑主根已分离并通过实测 app-server 参数探针 | `rewriteClientMessage` |
| Remote Bridge 权限配置 | 强制 `codex-remote-bridge` named profile、`approvalPolicy=never`，移除客户端 sandbox/config 覆盖 | `local-core-policy` / `rewriteClientMessage` |
| 本地客户端请求阻断 | 25 个 Shell、文件、命令、进程、模糊搜索和后台终端请求在 app-server 前失败关闭并审计 | `ShimProxy` / `ClientRequest.json` |
| Core 本地审批阻断 | 命令、文件、权限和两类旧协议审批在到达官方 UI 前失败关闭；Bridge 远程命令审批不受影响 | `ShimProxy` / `ServerRequest.json` |
| `thread/resume` 工作区语义 | 本地控制 `cwd`、远程 `runtimeWorkspaceRoots` 和远程策略已覆盖；官方 UI 恢复待补测 | `rewriteClientMessage` |
| `turn/start` 路由刷新 | 每轮合并独立应用上下文，刷新远程主根和 `remote_exec` 提醒且不覆盖已有键 | `rewriteClientMessage` |
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
| 远程逻辑主根 | 唯一 `remote/primary` 已写入线程和每轮 `runtimeWorkspaceRoots`；活动 transport 的 `pwd` 回环通过 |
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
| Core 内置本地工具硬阻断 | 部分实施；专用权限配置、25 个客户端请求和五类本地审批已失败关闭，真实模型专用工具诱饵待补测 |

阶段 C 尚未关闭。0.2.0 提供与官方权限模式一致的远程命令执行；写操作、取消、断线恢复
和本地执行硬阻断完成前，不得用于无人值守的有副作用任务。

## 最终阶段：外部 Codex CLI 介入

状态：最终待实施。该阶段排在双端安全写入、取消/幂等、后台任务、远程 URI 和 P0 收口
之后。本地外部 Codex CLI 将通过 Controller 的受控插件接口发现、读取并续接 Remote
Bridge 反代后的对话，向同一 thread 提交 turn，并复用 Bridge 写入协议修改远程工作区；
VS Code 插件负责显示来源、并发仲裁、审批、撤权和审计。

该 TODO 不改变当前运行时权威：官方扩展内置 Codex 仍是唯一 app-server 来源，系统
Codex CLI 不参与发现或回退，远端也不安装 Codex。当前尚无稳定外部插件 API、多客户端
对话代理、单写者租约或外部写入链路；实施前必须重新探查当时官方协议能力边界。

## 升级与发布跟踪

发布门禁、升级触发矩阵、量化回归规则和 Windows/Linux 分平台要求已统一写入
`docs/upgrade-tracking.md`，候选版本使用 `docs/acceptance/release-template.md` 保存独立
证据。0.2.7 首份基线位于 `docs/acceptance/2026-07-18-release-0.2.7.md`：Windows x64
Controller 到远端 Ubuntu Executor 的主链路已通过；Linux x64 Controller 仅完成打包和
内容核对，本地 Extension Host、CJS Shim、官方任务及 Remote SSH 运行时仍为待补测。
官方扩展内置运行时候选证据位于
`docs/acceptance/2026-07-22-release-0.2.7.md`，在真实任务门禁完成前不替代上一支持
基线。通用 MCP 适配器、Executor `0.2.6` / 协议 v4 和本次 Linux Remote SSH 新任务
证据位于 `docs/acceptance/2026-07-22-release-0.2.7-mcp-adapter.md`。Executor
`0.2.7` 精确版本门禁、真实安装、摘要一致性和主根探针见
`docs/acceptance/2026-07-22-release-0.2.7-executor-version-gate.md`；远程逻辑主根、逐轮
路由和活动 transport 回环见
`docs/acceptance/2026-07-22-release-0.2.7-remote-primary-root.md`。

## 本地 MCP 边界

远程工作区任务仍可使用本地 Codex app-server 原有的 MCP、App 和 Connector 服务，
Bridge 不会移除这些服务。Remote SSH 窗口会扫描本机 MCP，并把无凭据、无本地工作
目录、非包管理器启动且远端存在同名可执行文件的 stdio 服务通过当前 Bridge 目标启动；
默认 `vscode-remote` 模式使用本地 relay 和 Remote Executor 长生命周期子进程转发原始
stdin/stdout/stderr，复用当前 VS Code Remote SSH 连接；`openssh` 回退模式继续使用 SSH
stdio 中转。该传输不依赖 CodeGraph，可用于所有通过同一安全策略的直接 stdio MCP。
本地 relay 通过显式 `--session-config` 路径加载窗口 transport，避免 Codex Core 清理
`CODEX_BRIDGE_*` 环境变量后丢失会话；文件内随机令牌不会出现在命令行中。
服务私有的远端启动变化由共享适配器注册表描述；路由参数只携带受控适配器 ID，
VS Code Remote 由 Executor 在远端解析，OpenSSH 回退通过 stdin 控制头传递经过审核的
非凭据环境变化。未知适配器、服务名、可执行文件或工作区参数不匹配时失败关闭。
其余服务继续留在本机。`remoteMcpAccess=enabled` 保留已有启用和审批策略；
`remoteMcpAccess=all` 为当前 app-server 尝试启用已配置服务、清空工具禁用列表并
设置默认工具审批为 `approve`。覆盖会由同版本 Codex 校验；会替换插件层 transport
的不兼容服务保持原配置。所有覆盖仅作用于当前 app-server，不写入全局 Codex 配置。
CodeGraph 保留独立的工作区根目录参数适配，并作为首个注册适配器在 `all` 模式暴露
完整工具集合；它是通用适配链路的验收样例，而不是传输实现中的特殊分支。Linux x64
真实 Remote SSH 新任务已调用 `codegraph_status` 和 `remote_exec` 成功。
