# 实施状态

更新日期：2026-07-23

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
`ClientRequest`、线程设置更新、fork 和 turn 等 Bridge 依赖结构。当前
`npm run check` 为 37 个测试文件通过、1 个真实远端条件文件跳过，154 项通过、5 项
跳过、0 失败；插件内置 app-server 的本地共享网关、远程窗口启动、线程创建、本地
拒绝权限配置激活、主次根审计冒烟和 Linux x64 打包通过。系统 Codex CLI 的存在、
缺失或版本不再影响这些路径。

当前仍是候选状态：用户已重载活动 Remote SSH 窗口，进程和运行时指针确认目标窗口只
使用官方插件内置 Codex，Bridge 对规范化远端根进入 `ready`，已有会话恢复成功。
阶段 2B 已通过官方 app-server 参数探针，并用新候选 Shim 复用活动 VS Code transport
完成 `remote_exec(["pwd"])` 回环；线程和 turn 都收到唯一远程主根，原有上下文未被
覆盖，审计明确区分远程主根和本地控制目录。阶段 2C 已在候选 Shim 阻断 25 个已知
本地客户端请求和五类 Core 本地审批，官方 app-server 实际激活
`codex-remote-bridge` 权限配置，活动
transport 的远程 `pwd` 仍通过。真实模型的本地诱饵读写执行、官方 UI 新建/恢复、
附件、当前文件和本地窗口共享附着仍待补测。Linux 构建无法生成 Windows SEA Shim，
双平台产物收集仍为待实施项。

## 阶段 A：协议与运行位置探针

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 入口 | 已实现配置、备份和恢复 | `OfficialSettingsManager` |
| Remote SSH 自动配置与启动 | 已实现；首次设置变更自动重载一次 | `BridgeController.initialize` |
| 本地窗口隔离 | 已实现；无 Remote SSH 会话标记时保留原始 `cwd` 和请求，仅接入本机共享网关 | `SharedAppServer` / `rewriteClientMessages=false` |
| 官方扩展内置运行时 | 只接受当前官方扩展目录中的平台二进制；系统 CLI 不参与 | `resolveOfficialCodexExecutable` |
| 内置协议门禁 | Controller 与 Shim 校验插件内置 app-server 与生成协议；不固定插件版本 | `validateBundledCodexProtocol` |
| 旧 CLI 配置迁移 | 已删除公开设置；旧配置字段被解析器忽略 | `parseBridgeConfig` |
| Windows 原生 Shim | Node SEA `codex-bridge-shim.exe` 已构建并通过真实 Codex 冒烟 | `scripts/build.mjs` |
| 双平台发布 | 同一扩展 ID 分别生成 `win32-x64` 和 `linux-x64` VSIX | `scripts/package.mjs` |
| VS Code Remote 通道 | 已实现本机 IPC、远端 Workspace Executor 和内嵌 VSIX 自动部署；真实 Remote SSH 窗口只读回环已通过 | `VsCodeTransportServer` / `LocalProcessExecutor` |
| 密码/密钥认证复用 | `vscode-remote` 模式不新建 SSH，复用当前 Remote SSH 窗口认证 | `codexRemoteBridge.connectionMode` |
| 稳定启动器安装 | 已实现；Controller 激活时默认安装并随内容哈希变化刷新，显式停用会持久保留 | `reconcileExternalCliLauncher` |
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

## 当前优先阶段：外部 Codex CLI 介入

状态：源码与 Linux x64 自动化候选已完成；显式 `codex-vscode` 和普通 `codex` 自动
接管的本地窗口均已通过，Remote SSH 和 Windows 仍待补测。当前本地 Codex CLI 对话
通过 Bridge
持久注册的 stdio MCP 获得对话列表、读取、介入和取消工具；MCP 通过受控网关接入官方
扩展内置 Codex 所运行的同一 app-server，不要求切换到另一个远程 TUI。远程工具调用
仍经过既有请求改写、权限跟踪和活动 VS Code Remote SSH transport。

权限模型以接入 thread 的 Codex 权限模式为唯一权威，不增加 Bridge 自定义分级。常用的
`full-access` 在已选目标端自动放行命令、对话和项目写入，只保留来源与结果审计；其他
模式沿用 Codex 的询问和拒绝语义。目标端路由、并发仲裁、幂等和传输认证仍作为正确性
与连接边界保留。

2026-07-23 实测确认，官方 app-server 的两个独立 WebSocket 客户端可同时初始化；
第二客户端能恢复第一客户端的 thread，对同一活动 turn 成功调用
`turn/steer` 和 `turn/interrupt`。官方 CLI 已有 `--remote` 客户端入口，因此不再自造
对话协议或强制单写者租约。候选已实现共享上游生命周期、loopback 双令牌鉴权、每客户
端 Shim 代理、活跃 thread 发现、持久 MCP 注册与升级自刷新，以及
`vscode_codex_list_conversations`、`vscode_codex_read_conversation`、
`vscode_codex_intervene`、`vscode_codex_interrupt` 四个工具。跨客户端
`full-access` 跟踪由网关共享，自动化已证明 CLI 介入触发的 `remote_exec` 无 Bridge
二次审批。

同日真实流式复核发现，官方 app-server 不保证把外部连接触发的通知转发到 VS Code
使用的独立上游连接；原集成测试中的假服务器全局广播，掩盖了该方向缺口。`0.3.1`
现由共享网关统一广播无 ID 的 thread/turn/item 通知，并按来源和消息指纹短时去重；
带 ID 的响应、审批和服务端请求仍保持原连接路由，避免 ID 冲突或错误代答。

2026-07-23 根据真实交互预期再次收紧范围：上述 MCP 是控制面，不会把调用它的普通
CLI 会话自动迁移或镜像成 VS Code thread，因此不能声明“双向实时一致”。该目标进入
`0.3.1` 自动化候选：由托管本地入口使用官方 `codex --remote` 恢复 VS Code 当前 thread，
让两端直接消费同一 app-server 的有序事件。已经运行的普通 CLI 进程没有热切换
app-server 的官方接口，首次附着需要重启；Bridge 不通过修改 rollout 文件伪造同步。

同日对“当前 CLI 没有实时同步”的进程级复核确认：该 CLI 在 Bridge 网关启动前已经
运行，进程没有到 loopback 网关的连接，只保留自身 app-server，因此它只能看到服务端
历史而不能接收 VS Code 的实时事件。修复候选在 POSIX 上接管 PATH 实际解析到的普通
`codex` 符号链接，保存官方绝对入口和原始链接目标；下一次无参数启动自动按当前目录
附着唯一 VS Code thread，子命令和无活动 thread 时透传官方 CLI，歧义时失败关闭并要求
使用 `codex-vscode --session-pid`。停用集成会原样恢复链接，避免递归调用或永久覆盖
用户入口。

定向测试已增加“上游仅向原连接发通知”和“上游同时向多连接广播”两类服务器，分别
证明双向补发和去重。完整 `npm run check` 为 37 个测试文件通过、1 个真实远端条件
文件跳过，155 项通过、5 项跳过；真实 app-server 冒烟同时覆盖普通本地窗口与
Remote SSH 窗口的共享服务启动、
MCP initialize/tool list 和受鉴权外部 attach。普通本地窗口保持原始 `cwd`、权限和
审批请求，不注入 Remote SSH 策略；活动 workspace 和 thread 会写入本机会话描述符。
Controller 激活时默认自动协调 MCP、`codex-vscode` 和 POSIX 普通 `codex` 入口，
显式停用后才停止自动维护。
Linux x64 候选已安装并重载普通本地窗口；真实 `codex-vscode` 已恢复相同 thread，
显示当前对话、流式工具事件和历史。CLI 发起的验收 turn 返回
`CLI_TO_VSCODE_OK`，官方 UI 同时记录 thread 未读状态变化；审计记录自动协调、两次
外部连接与正常断开。随后 CLI 取消活动 turn，CLI 收到 interrupted 且官方 UI 收到
thread 状态变化，第三次附着也正常断开。安装新候选并重载后，Controller 自动把普通
`codex` 接管到新 Shim，同时保留官方入口绝对路径和原始相对链接；`codex --version`
正常透传。无参数 `codex` 从相同工作目录自动恢复同一 thread，实时显示本次用户输入、
回复、工具过程和完整历史，进程参数、loopback 连接及连接/断开审计均与
`codex-vscode` 路径一致。修复后的普通本地实机由外部连接启动
`019f8e9b-554e-7263-bb2b-c034c6c9a10b` turn，CLI 收到逐段
`item/agentMessage/delta` 和 `BRIDGE_LOCAL_STREAM_OK_2`；Bridge 断开摘要记录向 VS Code
主 stdio 客户端转发 10 条通知，官方 Codex 日志确认收到并绑定外部 turn。随后普通
`codex` 自动附着同一 thread 并显示两次验收输入与回复。Remote SSH 回归及 Windows x64
保持待补测。

该 TODO 不改变运行时权威：官方扩展内置 Codex 仍是唯一 app-server 来源；外部 Codex
CLI 只是客户端，不参与发现或回退，远端也不安装 Codex。

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
当前 CLI 持久 MCP 与共享 app-server 候选见
`docs/acceptance/2026-07-23-release-0.3.0-external-cli-mcp.md`。
双向实时同 thread 候选见
`docs/acceptance/2026-07-23-release-0.3.1-bidirectional-cli.md`。

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
