# 实施状态

更新日期：2026-08-02

## 能力边界复核

2026-07-22 已重新汇总全部待实现、待验证和待补测项，并核查当前源码、`0.144.5` 与
`0.145.0` 协议差异、Linux x64 自动化、活动 Remote SSH transport、Codex 日志和 Bridge
审计。详细边界、依赖顺序、分阶段实施内容与验收条件见
`docs/capability-boundary-plan.md`。

同日先完成外部稳定版 `0.145.0` 协议探针，随后按用户确认的边界将官方
`openai.chatgpt` 扩展设为唯一运行时权威。当前源码只启动 VS Code 实际加载的
`openai.chatgpt` 所内置的 Codex；最新实测组合为 `26.727.40816` /
`0.146.0-alpha.9.2`。源码删除公开
`codexExecutable` 设置、系统 CLI 发现和 PATH/`~/.local/bin` 回退；旧配置中的该字段
会被忽略。官方扩展和内置 Codex 版本只用于诊断、证据和协议快照索引；Controller
保存受限运行时指针，Shim 直接使用该指针。版本值不同、未知或缺失均不阻断启动。

当前协议位于 `protocol/0.146.0-alpha.3/`，由插件内置二进制生成，并包含
`ClientRequest`、线程设置更新、fork 和 turn 等 Bridge 依赖结构。此前 Linux 候选的
`npm run test` 为 62 个测试文件通过、1 个真实远端条件文件跳过，297 项通过、6 项跳过、
0 失败。Windows 测试现使用本机绝对路径夹具，并明确跳过依赖 POSIX symlink、远端 Linux
注册表或 POSIX 临时根的用例；`0.3.52` 在 Windows 为 63 个文件中 58 通过、5 跳过，
305 项中 280 通过、25 跳过、0 失败。`npm run check` 已完整通过类型检查、测试、构建、
Windows Shim 冒烟和构包；独立 `smoke:shim` 另连续通过 3 次。Windows 冒烟现使用平台原生
control path 断言、等待共享网关发布状态，并验证带令牌的外部 gateway 连接；第二个临时
`CODEX_HOME` 不再依赖网络鉴权，真实 app-server 请求转发仍由集成测试覆盖。插件内置 app-server 的
本地共享网关、远程窗口启动、线程创建、本地拒绝权限配置激活、主次根审计冒烟和 Linux
x64 打包的既有证据继续有效。系统 Codex CLI 的存在、缺失或版本不再影响这些路径。

2026-07-23 官方扩展自动升级到 `26.721.30844` 后，运行中的 `0.3.1` Controller 错误地
仅因内置 Codex `0.146.0-alpha.3` 与旧快照 `0.145.0-alpha.27` 不同而进入
`incompatible`。`0.3.2` 删除 Controller 与 Shim 的 Codex 版本比较，并把 Executor
精确包版本/协议号握手改为所需能力集合握手；所有版本值只保留为诊断信息。
同时已从当前官方扩展重新生成协议快照并重建 Shim。
结构化差异审查确认服务端请求仍为 11 项，动态工具以及 Bridge 使用的线程/turn 顶层
字段不变；客户端新增三个读取请求。定向协议测试、真实内置 app-server Shim 冒烟、
完整自动化、审计和 Linux x64 候选包已经通过。新 VSIX 安装后的普通本地窗口实机
回归已通过；后续 `0.3.3` 已完成限定范围的 Remote SSH 外部 CLI 实机回归，
`0.3.5` 已完成官方面板新任务、完整固定探针和多上游单次执行实机回归。Windows x64
仍待补测。

当前仍是候选状态：用户已重载普通本地与活动 Remote SSH 窗口，进程和运行时指针确认
两个窗口均使用官方插件内置 Codex，活动 Remote SSH 窗口使用精确 `0.3.37` Shim，
Bridge 对规范化远端根进入
`ready`。
`0.3.43` 修正普通无参数 `codex` 的自动会话选择：自动入口只考虑与当前工作目录完全
一致的活动 thread；没有目录匹配时透传官方 CLI，不再因其他 VS Code 工作区存在多个
活动 thread 而误报歧义；只有同一目录存在多个匹配 thread 时才要求
`codex-vscode --session-pid`。Executor 与远端协议未变。
`0.3.44` 继续修正普通本地窗口的任务历史隔离：Controller 从 VS Code API 获取当前
唯一 `file:` 工作区根，并以 Extension Host PID 为窗口身份保存最小上下文；Shim 在
每次官方 VS Code 客户端发起本地 `thread/list` 时动态读取，再写入协议原生精确 `cwd`
过滤。子进程环境仍作为无竞态时的快速路径并由 Shim 消费后清除。外部 CLI/MCP 保持
全局查询能力，Remote SSH 继续使用 Bridge thread/远端根语义，不把本地控制目录伪装成
远端工作区 URI。首次仅依赖环境继承的候选已在真实本地窗口复现激活顺序竞态，最终
PID 上下文方案重载后由用户确认任务列表不再混入其他工作区。
`0.3.45` 为 Remote SSH 任务列表建立相同的身份边界，但不把远端路径作为本地 URI 或
Core `cwd`：Bridge 根据规范化的 `host + workspaceRoot` 生成稳定摘要，为每个远端根
分配独立的本机控制目录。远程 thread 的 start/resume/turn 继续在该受限控制目录中
运行，逻辑主根仍由 `runtimeWorkspaceRoots` 和 Bridge 工具承载；官方 VS Code 客户端
的 `thread/list` 只查询当前控制目录。外部 CLI 的显式 thread 恢复能力保持不变。
旧版共享控制目录中的远程历史无法可靠区分所属远端根，因此不会合并进新列表。
`0.3.46` 修正 Remote SSH thread 对已远程路由 MCP 的工具选择说明。真实 `g1_1`
会话已经把 `codegraph` 通过活动 VS Code transport 绑定到远端主根，但旧策略只说明
“本地 MCP 必须显式支持 target/rootId”，没有把本次 app-server 实际接受的远程路由
列表交给模型，导致模型把无 `target/rootId` 参数的远端 Codegraph 工具误判成本地
工具。Shim 现在把实际 `remoteMcpServers` 从启动路由结果传入每个共享代理会话，在
thread start/resume/fork 和每轮上下文中明确列出已绑定远端主根的服务；列出的工具
可直接调用且不需要 Bridge 根参数。Codegraph 未被远程路由时，策略才要求先通过
`remote_exec` 探测并调用远端 CLI，而不是仅凭 MCP Schema 宣告能力不可用。
用户安装候选并手动重载 `g1_1` 后，活动 Shim 切换到精确 `0.3.46`，Bridge 重新进入
`ready`，远端 Codegraph MCP 进程继续绑定
`/home/unitree/mimiclite-sim2real`。共享 app-server 的真实新 turn 直接产生
`server=codegraph`、`tool=codegraph_explore`、`status=completed` 的 MCP 工具项，
没有 `remote_exec` 或 `workspace_*` 调用；模型返回
`REMOTE_CODEGRAPH_MCP_0346_OK`，证明缺少 `target/rootId` 不再被误判为不可调用。
`0.3.47` 修正首次 Remote SSH 自动初始化的官方扩展检测顺序。此前未托管 Shim 的窗口
会先调用 UI Extension Host 的 `vscode.extensions.getExtension("openai.chatgpt")`，
而 `remote.extensionKind.openai.chatgpt=["ui"]` 尚未写入，导致实际装在远端
Extension Host 的官方扩展被误报为未安装。自动初始化现在先走现有设置配置与窗口重载
链路；已有托管入口也先修复 extension kind，再刷新官方 Codex 运行时。只有设置已经
生效后才检测官方扩展和内置 Codex。定向类型检查与 automatic initialization、
Controller reconfigure、settings manager 共 11 项测试通过；精确 `0.3.47` 的真实窗口
迁移已随 `0.3.49` 最终候选重载复核：官方扩展运行于本地 UI Extension Host，日志
没有再次误报官方扩展未安装，窗口重载取消按正常生命周期记录。
`0.3.48` 将 Linux x64 Controller 中由 `/usr/bin/env node` 启动的 JavaScript Shim
替换为 Node SEA 自包含 ELF。构建仍保留 CJS 作为 SEA 输入和源码级中间产物，但 Linux
VSIX 只包含 `codex-bridge-shim` 原生入口，不再包含可被官方扩展直接启动的 CJS；
Windows VSIX 继续只包含 `codex-bridge-shim.exe`。内容寻址安装、旧 CJS 托管路径识别
和设置迁移保持兼容。在清空环境并把 `PATH` 限定为 `/usr/bin` 的探针中，自包含入口
能够运行并按预期因缺少测试运行时元数据失败，而不是报 `node` 不存在；完整 Shim 冒烟
也通过。精确 `0.3.49` 的真实官方面板已从内容寻址 ELF 启动；运行状态为
`nodeExecutable=null`，重载后日志没有 `/usr/bin/env: node`、退出 `127` 或 stdin
destroyed。
`0.3.49` 把状态栏 `ready` 从“远端 Executor 探针成功”收紧为“远端 transport 可用且
本机 Shim 存活、官方 app-server 已完成 VS Code 客户端 initialize”。Shim 按远端
工作区写入不含凭据的原子运行状态，记录自包含/Node 入口、PID、启动时间、最后退出码、
app-server 初始化时间和最后错误；Controller 持续检查 PID 与状态文件，在
`degraded`/`ready` 间恢复，不把仅远端连通的窗口标为完整就绪。Diagnostics 新增
`nodeExecutable`、`shimStarted`、`shimPid`、`shimLastExitCode`、
`appServerInitialized` 和 `appServerLastError`。设置写入触发窗口重载时的精确
`Canceled` 现在视为 Extension Host 正常终止信号，不再弹出无意义的 bootstrap failed。
状态持久化、位置、共享 app-server 与重载路径共 21 项定向测试通过；自包含 Shim 冒烟
同时验证 initialize 和退出状态。精确 `0.3.49` 已在 `g1_1` 真实窗口完成最终复核：
app-server 在 Shim 启动后 `127 ms` 完成 initialize；Bridge 先进入 `degraded`，
`250 ms` 后才进入 `ready`。官方新 turn 的 `remote_exec(["pwd"])` 和直接 Codegraph
MCP `codegraph_status` 均经活动 VS Code Remote transport 落在
`/home/unitree/mimiclite-sim2real`，模型返回 `REMOTE_STARTUP_0349_OK`。完整实机
证据见 `docs/acceptance/2026-07-28-release-0.3.49-linux-startup-real.md`。
`0.3.50` 修正 Remote SSH 对话中的文件引用跳转。官方扩展运行在本地 UI Extension
Host，收到远端 POSIX 绝对 Markdown 目标时会按本机 `file:` URI 打开并失败；Shim
现在只对 agent message 中位于规范远端主根内的 Markdown 文件目标做工作区相对投影，
保留行、列和行范围后缀。实时完成项与 `thread/read` 恢复的历史项使用同一投影；
代码段、普通路径文字、用户消息、根外路径和本地次级根保持原样。策略同时要求模型在
远程 thread 中直接生成工作区相对引用。精确 `0.3.50` 安装并重载 `g1_1` 后，用户在
恢复的历史对话中点击文件引用，确认 VS Code 成功打开远端文档并定位；重载后的 Codex
日志没有新增 `Failed to handle absolute path`。完整实机证据见
`docs/acceptance/2026-07-29-release-0.3.50-remote-file-links.md`。
`0.3.51` 修正 Remote SSH 窗口粘贴大段文本时附件一直停留在“正在添加”的问题。
此前 Shim 按风险命名空间阻断全部本地 `fs/*` 客户端请求，也误伤了官方 VS Code
客户端通过 app-server 管理本机 Codex 粘贴文本附件的请求。现在只对官方 VS Code
客户端开放 Codex 自管 `attachments` 根内的固定操作：读取或写入注册表、创建 UUID
目录、读写或删除固定 `pasted-text.txt`；方法、参数、路径形状和内容大小均受限，
外部客户端、根外路径、未知 `fs/*` 和异常形状继续失败关闭。审计仅记录方法和受管
路径类别，不记录路径、正文或 Base64。精确 `0.3.51` 安装并重载 `g1_1` 后，用户在
官方 Codex 面板完成大段文本添加、恢复到输入框和随消息提交。审计记录了目录创建、
粘贴文本与注册表写入，以及恢复后的文本删除和注册表更新，没有新的附件请求阻断。
完整实机证据见
`docs/acceptance/2026-07-30-release-0.3.51-remote-pasted-text.md`。
`0.3.52` 修正 Windows Controller 没有持续同步配套 Remote Executor 的问题。Controller
现在每次 Remote SSH 初始化都会读取 Executor 从自身扩展清单上报的实际包版本，并与
当前 Controller 内嵌 VSIX 的配套版本比较；缺失、较旧或较新都触发通过活动 VS Code
Remote SSH transport 安装内嵌版本和自动重载。能力集合仍是运行时接纳依据，版本不匹配
只触发包同步，不会把仍兼容的 Executor 判为不兼容；同步失败时也保留兼容链路。Executor
升级到 `0.2.20` / 诊断协议 12。精确 `0.3.52` 安装在 Windows x64 并重载
`xj-member-42028` 后，日志记录从未上报包版本、运行版本 `0.2.19` 自动安装 `0.2.20`，
随后自动重载；重载后的实际扩展上下文连续回报包版本和运行版本均为 `0.2.20`，Bridge
以 `shimStarted=true`、`appServerInitialized=true` 进入 `ready`。

同一候选还修正当前 Windows 内置 app-server 创建 Remote SSH task 时的
`Invalid request: AbsolutePathBuf deserialized without a base path`。直接探针确认
`0.146.0-alpha.9.2` 无法在 Windows 反序列化 POSIX `runtimeWorkspaceRoots`；Shim 现在仅在
Windows 使用真实本机控制目录作为 app-server runtime root，远端 POSIX 主根继续由 Bridge
策略、附加上下文和动态工具承载，不改写或伪造 VS Code 工作区 URI。四类 thread/turn
请求的定向测试和隔离 Shim 探针通过。用户随后通过官方面板创建任务；活动内容寻址 Shim
收到请求，审计记录 `workspace_git_status`、`workspace_read_file` 和 `remote_exec` 均在
`/root/work/train/MimicLite` 成功完成。

此前 VS Code 任意扩展变更事件还会使 Controller 每隔数秒重新初始化。激活入口现仅在
官方 `openai.chatgpt` 或 Remote Executor 的安装路径/包版本指纹实际变化时重新初始化，
忽略无关事件。最终候选重载后用户确认稳定，连续 20 秒观察期间 Bridge 日志字节数和最后
写入时间均未变化，没有重复升级或重配置。完整证据见
`docs/acceptance/2026-07-31-release-0.3.52-executor-package-reconciliation.md`。
`0.3.53` 至 `0.3.58` 收口 Windows 外部 CLI 显式附着链路。Windows PATH 解析现在优先
选择 `PATHEXT` 对应的 npm `codex.cmd`，`.cmd` / `.bat` 统一通过安全的 `ComSpec`
调用；托管 `codex-vscode.exe`、外部 MCP 注册与真实 `tools/list` 已通过。临时 thread
改用 `thread/resume(excludeTurns=true)` 判定 rollout；官方 UI 在窗口重载后通过
`thread/read` 或成功 turn 恢复历史任务时，共享网关会用请求内 thread ID 更新活动会话。
显式 `--thread-id` 不再被描述符中的旧活动 thread 提前过滤。

最终 `0.3.58` 还修复冷启动 initialize 超时被误当成可恢复的问题：超时客户端立即关闭
并重试一次，只有实际 resume 成功才进入恢复，明确无 rollout 才启动同步新 thread，
其他错误上抛。真实 Windows 单命令样本首连在 `30,011 ms` 超时后立即清理，重试
initialize 为 `1 ms`，resume 在 `73 ms` 内明确失败，随后 TUI `thread/start` 为
`94 ms` 并正常进入；退出后相关外部进程为 0。完整证据见
`docs/acceptance/2026-08-02-release-0.3.58-windows-external-cli.md`。

`0.3.59` 将同一自动附着能力扩展到 Windows npm 普通入口。Controller 仅在无扩展
`codex`、`codex.cmd` 与 `codex.ps1` 同时是同目录普通文件时接管完整集合，把原始 wrapper
原样移动到相邻隐藏备份，并通过稳定的 `codex-vscode.exe automatic-cli` 内部入口区分
普通自动附着与显式 TUI。无参数启动按当前目录选择唯一活动会话，无匹配时透传备份的
官方 CLI，歧义仍失败关闭；带参数调用始终透传。停用时只恢复仍匹配 Bridge 内容的文件，
外部修改优先保留；npm 覆盖 wrapper 后，下一次初始化会把新文件刷新为备份并重新接管。
Windows 实机已完成唯一同目录会话附着、无匹配透传、PowerShell/CMD 参数透传、精确
停用恢复、重新启用，以及真实 `npm install -g @openai/codex@0.146.0` 覆盖后的重载恢复。
完整证据见
`docs/acceptance/2026-08-02-release-0.3.59-windows-automatic-cli.md`。

`0.3.60` 修复官方扩展在 Windows UI Extension Host 中把 Remote SSH POSIX 根转换为
`\\root\\...` 本机路径，并由 `git-init-watcher` 每五秒重试 `fs.watch` 的问题。兼容层不
改写 VS Code 工作区 URI，而是按当前官方扩展资产的实际代码形状定位 Git 初始化监视器，
让它复用官方包内已经用于 working tree 的 `vscode.workspace.createFileSystemWatcher`
适配器；找不到唯一监视器、适配器或 `vscode-remote` URI 映射时失败关闭，Bridge 核心
链路继续工作。原资产按 SHA-256 原样备份，补丁和备份均记录哈希；重复初始化幂等，官方
扩展升级时只处理同一扩展目录下的安全相邻安装，外部修改、备份篡改和元数据路径篡改均
拒绝覆盖。`Codex Bridge: Restore Official Codex Settings` 同时恢复托管资产。

Windows 实机安装 `0.3.60` 后，官方扩展 `26.727.40816` 的直接 watcher 调用从 1 处变为
0 处、官方远程 watcher 调用变为 1 处；历史日志最后一条告警停在 `03:24:07.027`，补丁
生效并安装最终候选再次重载后日志持续写到 `03:42:28`，新增告警为 0。Bridge 恢复
`ready`，当前 Shim/App Server 新建的只读验收 thread 成功执行 `workspace_git_status`、
`workspace_read_file(README.md)` 和 `remote_exec(["pwd"])`，三项均审计为远端主根
`/root/work/train/MimicLite`，没有伪造 URI 或本地项目回退。完整证据见
`docs/acceptance/2026-08-02-release-0.3.60-windows-git-init-watcher.md`。
阶段 2B 已通过官方 app-server 参数探针，并用新候选 Shim 复用活动 VS Code transport
完成 `remote_exec(["pwd"])` 回环；线程和 turn 都收到唯一远程主根，原有上下文未被
覆盖，审计明确区分远程主根和本地控制目录。阶段 2C 已在候选 Shim 阻断 25 个已知
本地客户端请求和五类 Core 本地审批，官方 app-server 实际激活
`codex-remote-bridge` 权限配置，活动
transport 的远程 `pwd` 仍通过。真实模型的 Core 本地诱饵执行、当前候选官方 UI 恢复、
视觉和完整生命周期仍待补测。`0.3.5` 已用校验过的官方 Windows Node 归档
完成双平台构包，但 Windows 原生构建和实机仍待补测。

## Codex 原生上下文入口能力探针

2026-07-28 完成首份可修改性探针，样本为本机实际加载的官方扩展
`26.721.41059`，该版本不作为运行时门禁。

可修改性结论：

- Codex 侧栏是官方扩展注册的独立 Webview，入口为 `webview/index.html`，界面逻辑位于
  随扩展安装的打包 JavaScript。当前安装资产归本机用户所有并可写，因此重载前替换
  资产在技术上可改变界面。
- VS Code 没有允许一个扩展访问另一个扩展 Webview DOM 或直接向其发送消息的公开
  API。直接改写官方安装目录属于不受支持的补丁，会被官方扩展升级替换，不能作为
  默认、无恢复能力的实现方式。
- 官方扩展已经公开 `chatgpt.addToThread` 和 `chatgpt.addFileToThread` 命令，但当前
  菜单只覆盖编辑器，未注册资源管理器右键入口。`addFileToThread` 的实现只接受一个
  `file:` URI，再向官方 Webview 发送私有的 `add-context-file` 消息；它不接受
  `vscode-remote:` 或 Bridge 虚拟资源 URI。
- 官方编辑器已实现本机文件拖放，但当前拖放解析会明确丢弃
  `webkitGetAsEntry().isDirectory` 的项目。Remote SSH 窗口中官方扩展被放置在本地
  UI Extension Host，因此本机文件拖放具备实现基础；精确行为仍须用候选 VSIX 和
  官方界面验收。

活动实施项及其退出条件统一保存在根 `README.md` 最末尾的 `TODO` 中；本节只保留已完成
的能力探针结论。

## 阶段 A：协议与运行位置探针

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 入口 | 已实现配置、备份和恢复 | `OfficialSettingsManager` |
| Remote SSH 自动配置与启动 | 已实现；首次设置变更自动重载一次 | `BridgeController.initialize` |
| 本地窗口隔离 | 已实现；无 Remote SSH 会话标记时保留原始 `cwd` 和请求，仅接入本机共享网关 | `SharedAppServer` / `rewriteClientMessages=false` |
| 官方扩展内置运行时 | 只接受当前官方扩展目录中的平台二进制；系统 CLI 不参与 | `resolveOfficialCodexExecutable` |
| 版本无门禁 | Controller、Shim 和 Executor 不按任何组件、包或协议版本值接纳；只校验实际路径、能力、消息结构和操作结果 | `OfficialCodexRuntime` / `isRemoteExecutorPing` |
| 旧 CLI 配置迁移 | 已删除公开设置；旧配置字段被解析器忽略 | `parseBridgeConfig` |
| 双平台原生 Shim | Linux x64 `codex-bridge-shim` 与 Windows x64 `codex-bridge-shim.exe` 均使用 Node SEA；Linux 无需 PATH 中安装 Node | `scripts/build.mjs` |
| 双平台发布 | `0.3.22` 要求 Linux/Windows 原生构建分别生成带摘要清单的 stage；收集器复核版本、启动器隔离和 Executor 实现后才更新 `dist/`，不再用预存异平台启动器交叉构包 | `scripts/package.mjs` / `scripts/package-artifacts.mjs` |
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
| 本地客户端请求阻断 | 25 个 Shell、文件、命令、进程、模糊搜索和后台终端请求在 app-server 前失败关闭并审计；仅官方 VS Code 客户端的 Codex 自管粘贴文本附件请求按固定形状放行 | `ShimProxy` / `ClientRequest.json` |
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
| 工具根身份 | 请求、结果和审计携带根 ID、目标端、角色与根路径；省略目标仍默认远程主根 |
| 本地次级根授权 | `0.3.13` 已提供显式选择、持久化、撤销和诊断；最多 15 个规范化 `local/secondary` 根 |
| Controller 本地只读执行器 | `0.3.13` 已实现读取、目录、树、字面搜索和 Git 状态，并覆盖父路径、符号链接、根替换与撤销防线 |
| 双端只读路由 | `0.3.14` 已通过统一 `workspace_*` 工具按显式目标和根 ID 路由；本地请求只经已认证 Controller transport，远端维持现有执行器路径 |
| Bridge 工具原生界面投影 | `0.3.14` 已按本地/远程根显示目标、根 ID、规范化路径和 `cwd`；真实候选窗口观感待补测 |
| 远程 URI、Diff 和文件跳转 | `0.3.21` 已实现 host/根/目标端/相对路径资源身份、会话登记内容提供器、实际 Remote SSH URI 跳转和有界旧内容 Diff；OpenSSH 失败关闭，真实同名诱饵与界面待补测 |

阶段 B 的远端执行器与 Shim 动态只读工具已通过真实 SSH 验收，双端路由已通过自动化。
尚缺候选 VSIX 中的本地同名诱饵、VS Code 当前文件、远程链接和界面侧验收，因此阶段 B
仍未整体关闭。

## 阶段 C：远程命令与写入

| 项目 | 状态 |
| --- | --- |
| 结构化 `argv` 非交互命令 | 已实现；默认通过 Remote Extension Host，OpenSSH 为回退 |
| 官方命令审批 | 已实现；非完全访问模式显示主机、规范化 `cwd`、完整命令和环境变更 |
| 命令输出流 | 已映射为 `item/commandExecution/outputDelta` |
| 权限模式继承 | 已按线程映射 `full-access`/`approvalPolicy=never`，其余模式失败关闭 |
| 审批绑定 | 人工审批仅匹配一个待处理调用 ID；完全访问的自动放行单独审计 |
| 运行中取消 | `0.3.15` 已把 `turn/interrupt` 绑定到活动 Bridge 调用；VS Code Remote 通道显式发送 `cancel`，Remote Executor 按 operation ID 中止 POSIX 进程组；自动化通过，真实 Remote SSH 与 Windows 待补测 |
| 哈希保护写入和补丁 | `0.3.19` 已实现双端原子整文件写入和精确 UTF-8 补丁；覆盖、补丁、文件重命名和文件删除要求最新 SHA-256，冲突返回 `FILE_CONFLICT` |
| 目录与路径变更 | `0.3.19` 已实现单级目录创建、不覆盖重命名、文件或空目录删除；递归删除不开放 |
| 写入审批与审计 | 覆盖、补丁、重命名和删除在非完全访问模式进入绑定调用 ID 的官方审批；新建文件/目录为有界自动操作；`full-access` 自动放行，审计不含正文 |
| 写入幂等与上限 | 默认远端复用 Executor 账本，本地 Controller 有独立有界账本；文件正文最多 1 MiB，经 stdin 传输，不进入 argv |
| 断线结果确认和幂等 | `0.3.17` 已在 transport 中断后用原幂等键从新 socket 查询账本；completed 返回原结果，cancelled/failed 保留终态，running 有界轮询，unknown 或查询不可达返回 `RESULT_UNKNOWN` 且不重放；账本有意限定在当前 Extension Host 代次，`0.3.28` 已实测重启后旧状态为 `unknown` 且不重放 |
| Executor 失联写入完整性 | `0.3.37` 把已发送副作用的 transport 错误响应提升为不可重试 `RESULT_UNKNOWN`，写入脚本在替换前校验精确 stdin 字节数；临时文件先登记拥有 PID，新 Executor 激活时只清理当前工作区死亡拥有者的登记和临时文件。能力握手要求 `executeStdinExactLength` 与 `workspaceWriteOrphanCleanup`，不以版本号门禁；精确 Linux Remote SSH 故障注入确认原文件不变、无残留且不重放 |
| 后台任务 | `0.3.20` 在活动 VS Code Remote transport 上提供 start/status/log/cancel；稳定任务 ID 避免重连重复启动，日志按字节游标有界保留，取消、超时和 Extension Host 关闭终止进程组；OpenSSH 回退失败关闭 |
| 远程资源映射 | `0.3.21` 提供 `workspace_open_file` 与 `workspace_show_diff`；Controller 只映射已规范化路径，复用实际打开的 Remote SSH URI，并以会话登记、根授权复核、SHA-256 和内存上限保护内容提供器与 Diff 快照 |
| Core 内置本地工具硬阻断 | 自动化边界已实施；除官方 VS Code 客户端的受管粘贴文本附件操作外，专用权限配置、25 个已知客户端请求、五类本地审批及未来风险命名空间均失败关闭，真实模型专用工具诱饵待补测 |

阶段 C 尚未关闭。0.2.0 提供与官方权限模式一致的远程命令执行，0.3.15 完成默认
VS Code Remote 链路的运行中取消自动化闭环，0.3.16 增加当前 Executor 代次内的有界
幂等账本与结果查询，0.3.17 增加断线后的查询恢复，0.3.19 交付双端写入自动化，
0.3.20 交付后台任务生命周期自动化，0.3.21 交付远程资源、文件跳转和 Diff 自动化；
本地 Core 真实诱饵、真实写入和生命周期验收完成前，不得用于无人值守的有副作用任务。

## 当前优先阶段：外部 Codex CLI 介入

状态：源码与 Linux x64 自动化候选已完成；显式 `codex-vscode` 和普通 `codex` 自动
接管的本地窗口均已通过，`0.3.5` 也已完成真实 Remote SSH 官方任务、外部 CLI 多轮、
工具打印、权限继承、VS Code 投影和广播请求单次执行；Windows 和完整生命周期仍待
补测。当前
本地 Codex CLI 对话
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

Windows `0.3.59` 使用同样的选择语义，但不伪造 symlink：它成组管理 npm 生成的 shell、
CMD 与 PowerShell wrapper，并保存各自原始字节。自动化覆盖不完整集合、备份冲突、元数据
篡改、npm 覆盖刷新、外部修改保护和歧义选择；真实 Windows 窗口已完成自动附着、停用
恢复和 npm 重装后的自动修复。

定向测试已增加“上游仅向原连接发通知”和“上游同时向多连接广播”两类服务器，分别
证明双向补发和去重。完整 `npm run check` 为 37 个测试文件通过、1 个真实远端条件
文件跳过，157 项通过、5 项跳过；真实 app-server 冒烟同时覆盖普通本地窗口与
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
`codex` 自动附着同一 thread 并显示两次验收输入与回复。该轮尚未执行 Remote SSH；
后续 `0.3.3` 已补齐外部 CLI 限定链路，Windows x64 保持待补测。

随后对工具过程执行了更严格的真实窗口复核：CLI 连续发起三轮对话，并依次调用慢速
Shell、CodeGraph MCP 和 `pwd`。官方 UI 在运行中显示工具名称和增量输出，完成后可从
“已处理”进入“运行了多个命令”，再展开单条记录查看命令、输出、错误或成功状态。
协议旁路观察确认 Bridge 实时转发 `item/started`、
`item/commandExecution/outputDelta`、`item/completed` 和最终回复。官方 app-server
对超过首次 exec 等待窗口的命令存在一个上游边界：初始 exec 返回中的第一段 stdout
不生成 `commandExecution` 通知，且最终 `aggregatedOutput` 也不包含该段；两次独立
慢命令均复现。Bridge 无法转发未收到的事件，也不通过读取或伪造 rollout 补齐；后续
增量、完成状态和其他工具链过程均已在 VS Code 同一 thread 实时显示。

安装 `0.3.2` 后的再次重载还验证了无版本门禁迁移。首次启动命中已删除的官方扩展旧
可执行文件路径并产生一次 `ENOENT`，Controller 自动把托管入口迁移到当前内容哈希
Shim 并触发第二次重载；随后 `0.3.2` Shim 使用当前官方扩展内置 Codex 完成
`initialize` 和原 thread 恢复，没有再出现协议版本不兼容提示。无参数普通 `codex`
再次附着该 thread，并从 CLI 发起包含 `pwd` 和 CodeGraph `codegraph_status` 的真实
turn，最终返回 `ACCEPTANCE_OK`；Bridge 审计确认向 VS Code 主客户端转发 22 条通知。
当时 `code --status` 仅有一个普通本地窗口，因此该结果不能替代 Remote SSH 回归。

`0.3.3` 在真实 `g1_1` Remote SSH 窗口完成了该回归，并修复两个实机缺口：VS Code
只有描述符但尚未物化的 thread 不再强行 `resume`，`codex-vscode` 会自动新建同步
thread；外部 CLI 创建的会话会把 `permissions=full-access` 和
`approvalPolicy=never` 纳入共享网关权限跟踪。真实 TUI 显示 YOLO 模式并连续完成
两轮，第二轮依次打印远端 `pwd`、README 读取和 CodeGraph `codegraph_status` 的调用
过程与结果，全程没有 Bridge 二次审批。审计记录 `remote_exec.approval` 为自动
`full-access`，并向 VS Code 主客户端转发 141 条通知；官方 Codex 日志和结构化读取
确认同一 thread 在界面中处于活动状态且包含 2 个已完成 turn。`npm run check` 为
157 项通过、5 项跳过；Linux Controller/Executor 产物通过。`npm run package:all`
仍因 Linux 工作区缺少 Windows SEA Shim 失败，该结果只支持 Linux 限定链路，不能
推断 Windows 通过。

后续两轮只读回归发现原生工具投影仍有一个准确性缺口：远端
`git status --short` 实际退出码为 `128`，结构化工具结果和模型总结均正确，但 VS Code
中的 `commandExecution` 项被固定投影为退出码 `0` 和成功状态。`0.3.4` 改为从
`ToolResult.data` 或错误详情保留远端命令的实际退出码和信号；非零退出码在界面中标记
为失败，但 RPC 本身仍保持已完成，避免把命令失败误报为传输失败。定向 8 项测试和
`npm run check` 的 160 项通过、5 项条件跳过已经完成。Linux x64 活动 Remote SSH
窗口中又用实际退出码 `23`、`37` 完成两轮外部 CLI 复测；只读观察器捕获第二轮
`commandExecution` 为 `status=failed`、`exitCode=37`，证明修复后的结构化投影已进入
共享 app-server 广播。官方面板按钮发起和 Windows x64 实机仍待补测。

`0.3.5` 随后修复了广播的执行语义：真实 `0.3.4` app-server 在官方 stdio 与外部 CLI
同时连接时，把 25 个逻辑固定探针各执行了两次。共享协调器现按 thread、turn 和 call
身份复用同一执行结果，并拒绝身份相同但参数不同的请求。用户手动重载后从官方面板
创建的新任务成功返回远端 `pwd`；并发外部介入和 5 轮共 25 个固定探针均只记录一个
执行连接，重复 `requestId` 为 0。定向广播测试连续 5 轮、完整 160 项自动化和双平台
构包通过。当前旧 CLI 仍按设计使用其启动时的 `0.3.4 external-mcp`，其父进程关系已
确认，不属于孤儿进程；设置恢复、CLI 退出后清理和 Windows 实机仍待处理。

`0.3.6` 继续关闭一个独立生命周期缺口：主 stdio 结束时不再直接 terminate 外部
WebSocket，而是发送 `1012 / Bridge app-server restarting`，等待至多 250 毫秒后才
强制终止，并正常关闭官方上游。关闭集成测试连续 5 轮通过。真实 Remote SSH 观察器
跨用户手动重载收到固定关闭码与原因，`sawError=false`；旧 Shim PID、描述符和两份
令牌均清理，新窗口约 4.726 秒恢复 `ready`，`initialize/thread/list` 通过。历史
`notLoaded` thread 的显式恢复返回 `thread not found`，设置恢复和其他关闭类型仍作为
独立待补项。

`0.3.8` 完成真实设置恢复与停用空闲态。用户执行恢复命令后，原始
`chatgpt.cliExecutable` 缺省值和 `remote.extensionKind` 中的 Codex 缺省项恢复，
无关 `pub.name` 保留，`autoInitialize=false`，设置备份清空。恢复驱动的停止删除窗口
会话；用户重载后旧 Shim、描述符和两份令牌均清理，且没有新建会话、Shim、app-server
或远端 Codex。初始化策略现区分托管 Shim 修复、独立外部 CLI 对接和 Remote SSH 自动
连接，外部 CLI 对接不再错误依赖官方 VS Code 扩展。重新启用、独立停止、完整
Extension Host 退出和 Windows 实机仍待补测。

`0.3.10` 修复设置恢复后的重新启用顺序。首个 `0.3.9` 候选在写入
`remote.extensionKind.openai.chatgpt=["ui"]` 后，因同一 Extension Host 尚未注册
`chatgpt.cliExecutable` 而失败，随即废弃。设置管理器现先写 UI 路由并返回重载，下一
Extension Host 再写 Shim；Controller 在设置完整前不解析官方运行时或启动 transport，
交互配置重新启用自动初始化并延迟重入。用户从真实部分配置现场恢复后，本地官方
app-server、窗口会话和 CodeGraph relay 启动，Bridge 重新进入 `ready`，远端仍不安装
Codex。

`0.3.11` 修复历史对话可读但不能接管的问题。官方 app-server 的 `thread/read` 能返回
`notLoaded` thread，却不会把它注册为可接受 turn 的运行对象；旧路径随后直接
`turn/start`，真实返回 `thread not found`。外部对话客户端现在先按实际能力调用
`thread/resume(excludeTurns=true)`，再查询活动 turn 或启动新 turn。单元测试精确覆盖
请求顺序，候选源码客户端也已对真实官方 app-server 完成
`read -> resume -> start -> completed`，固定返回
`HISTORICAL_THREAD_INTERVENE_0311_OK`。候选 VSIX 安装后的 Remote SSH 工具回归和
Windows 实机仍待补测。

`0.3.12` 开始阶段 3 的协议和类型提交。全部 `remote_*` 动态工具 Schema 现在接受可选
`rootId` 和固定远端 `target`；省略时保持唯一远端主根的原行为。工具结果与审计显式
记录根 ID、目标端、主次角色和规范化根路径，为后续本地次级根执行器提供稳定身份。
直接请求配置中的本地根会返回 `COMMAND_DENIED`，不调用远端执行器，工具结果也不暴露
本地路径。本地目录选择、授权撤销、Controller 本地执行器和双端 UI 投影仍待后续提交。

`0.3.13` 完成本地授权执行器提交。Controller 命令面板增加本地目录授权和撤销；授权以
规范化 `local/secondary` 根持久化到扩展全局状态，并同步进入 Bridge 配置和活动窗口
会话配置。诊断报告会逐根运行本地执行器的规范路径探针。本地执行器只开放限额读取、
目录、目录树、字面文本搜索和固定的只读 Git 状态，逐次查询当前授权；父路径、符号链接
逃逸、授权根被重定向及撤销后的已有执行器请求都会失败关闭。该提交尚未让动态工具
接受 `target="local"`，避免在执行边界验证前扩大访问面。

`0.3.14` 完成双端只读路由和原生工具投影提交。Shim 公开统一的 `workspace_*` 读取、
目录、目录树、字面搜索和 Git 状态工具，远程主根保持默认目标，本地目标必须显式提供
当前授权的次级根 ID。Shim 通过现有窗口级认证 transport 把本地请求交还 Controller，
Controller 再次核对会话配置与实时授权；请求不会到达 Remote Executor，也不开放任意
本地命令。旧 `remote_*` 只读工具名继续兼容且只能访问远程主根。两端的结果、审计与
原生命令项均保留目标端、根 ID、角色、规范化路径和正确 `cwd`；候选 VSIX 的同任务
交替读取和界面观感仍待实机补测。远端搜索同时从正则匹配统一为大小写敏感的字面
匹配，因此 Remote Executor 实现版本升到 `0.2.9`；能力集合和协议形状保持不变。

`0.3.15` 完成阶段 4 的 transport cancel 与进程树终止提交。Shim 将
`turn/interrupt` 精确关联到同一 thread/turn 的活动工具调用，取消等待审批时不会启动
命令。默认 `vscode-remote` 链路用原 operation ID 发送独立 `cancel` 请求；Controller
在调用方 socket 意外断开或自身关闭时也会请求远端取消。Remote Executor 以
`host + workspace + operation ID` 保存 `AbortController`，本地执行器为 POSIX 命令
创建独立进程组并依次发送 `SIGTERM`/`SIGKILL`。进程树、断线触发、协议往返和审计
自动化已通过，因此 Executor 升到 `0.2.10`、诊断协议号升到 5 并声明 `cancel`
能力。真实 Remote SSH 取消耗时和遗留进程、Windows 行为、OpenSSH 回退远端进程身份、
Controller 断线后的账本查询恢复仍待后续目标。

`0.3.16` 完成阶段 4 的幂等账本与结果查询提交。Shim 从
`threadId + turnId + callId` 派生固定长度的稳定键并随 `remote_exec` 传到默认
VS Code Remote 链路；Remote Executor 以 host、workspace 和幂等键分区，在当前
Extension Host 代次内合并运行中重复请求，回放 completed、cancelled、failed 或
unknown 终态。同一键若参数或执行策略不同会返回 `PROTOCOL_MISMATCH`，不会产生第二次
副作用。账本同时限制保留时间、条目数和结果字节数；无法安全保留的大结果留下
`RESULT_UNKNOWN` 墓碑。协议新增 `resultStatus` 能力，Executor 升到 `0.2.11`、诊断
协议号升到 6；审计记录 `executed`、`joined` 或 `replayed`。transport 断线后的
自动查询编排由 `0.3.17` 继续完成。

`0.3.17` 完成阶段 4 的断线查询恢复提交。Shim 中的 `VsCodeRemoteExecutor` 在有副作用
请求因 transport 中断变成未知结果后，不重发原命令，而是使用原幂等键建立新 socket
调用 `resultStatus`。completed 状态返回原命令结果并标记 `replayed`；
cancelled/failed 还原远端错误；running 在三秒有界窗口内轮询；unknown、查询持续
不可达、账本响应缺失或恢复窗口结束都明确返回 `RESULT_UNKNOWN`。Remote Executor
实现和协议形状没有变化，因此继续使用 `0.2.11` 和诊断协议号 6。`0.3.28` 已确认
Extension Host 重启后旧前台和后台状态为 `unknown` 且没有重发；真实窗口关闭和
Executor 独立失联仍按生命周期门禁分别待补测。

`0.3.18` 将 Remote SSH 会话的本地 Core 客户端阻断从已知方法枚举提升为风险命名空间
失败关闭。`fs/`、`process/`、`command/exec`、`fuzzyFileSearch`、后台终端和
`thread/shellCommand` 下未来新增的方法即使尚未出现在生成协议清单中，也不会被转发到
本地 app-server；审计区分已知方法和前向未知方法。真实模型是否存在完全不经过客户端
请求或审批通道的专用工具路径，仍按统一人工清单执行诱饵负测。

`0.3.19` 完成阶段 5 的双端安全写入自动化。统一工作区执行器新增整文件写入、精确
UTF-8 补丁、目录创建、非覆盖重命名和文件或空目录删除；本地授权根经 Controller
执行，远端主根经 Remote Executor 或显式 OpenSSH 回退执行。文件覆盖和破坏性变更
绑定最近读取的 SHA-256，写入限制为 1 MiB 并使用同目录原子替换；正文在默认通道中
通过 stdin 传输。重要操作沿用 thread 权限审批，`full-access` 自动放行并审计。
Executor 增加 `executeStdin` 能力，升到 `0.2.12`、诊断协议号 7；真实双端写入和
Windows 运行仍按统一人工清单补测。

`0.3.20` 完成阶段 6 的后台任务自动化。Shim 新增 background
start/status/log/cancel 四个动态工具，启动复用 thread 权限审批并只记录任务元数据；
Remote Executor 按工作区与稳定任务 ID 隔离任务，最多保留 8 项、每项 4 MiB 日志和
15 分钟终态，单次日志读取最多 256 KiB，任务寿命上限 24 小时。启动响应断线后只按
任务 ID 查询，不重发命令；取消、超时和 Extension Host 关闭终止 POSIX 进程组。
Executor 升到 `0.2.13`、诊断协议号 8，并新增四项 background 能力；真实 Remote SSH
候选窗口、窗口关闭和 Windows 进程树仍按统一人工清单补测。

`0.3.23` 完成外部 CLI 项目写入和审计闭环。CLI 触发的文件修改继续复用双端安全
写入协议、thread 权限、原子替换和幂等协调器；共享网关按 thread/turn 保存实际发起
客户端，使广播工具请求即使由 stdio 代理执行，操作和审批仍归因到 CLI/MCP 来源。
外部 RPC 的开始、终态和断开取消均记录客户端实例与 operation ID，且不记录输入或
文件正文。真实 `test_40` / Zklab 双客户端写入、冲突、权限撤销和 Windows 实机仍按
统一人工清单补测。

`0.3.26` 为历史 thread 缺少后续动态工具的问题提供显式完整能力新对话入口。外部 MCP
按活动 Bridge `sessionPid` 调用官方 `thread/start`，再在新 thread 启动首 turn，使
当前工具集合在创建时注入；不修改历史 thread，也不合成 Remote SSH 工作区 URI。
入口显式区分 `on-request` 与 `full-access`，后者按官方协议设置完整访问和
`approvalPolicy=never`，项目操作仍经过 Bridge 目标端、路径、哈希、幂等和审计边界。
官方 app-server 不支持临时 thread 的完整历史读取，因此没有公开无法观察和清理的
ephemeral 选项。Zklab 单样本已完成新 thread 只读、steer、运行中取消和临时写入清理；
最终 `0.3.26` 已在 `g1_1` 重载，并完成新 thread、后台任务取消及经 VS Code transport
路由的 CodeGraph 状态调用；最低量化样本和 Windows 实机仍按统一人工清单补测。

`0.3.33` 修复了该入口在普通本地共享网关上的实际协议形状：`permissions` 是命名权限
档案 ID，不能填入显示模式 `full-access`；外部入口现在发送
`approvalPolicy=never` 和协议支持的 `sandbox=danger-full-access`。普通本地网关保持
原请求语义，Remote SSH 网关则按现有目标策略删除 sandbox 并映射到 Bridge 本地拒绝
档案，远端项目能力继续由动态工具和 thread 权限自动放行。该行为只按字段能力和真实
操作验收，不按官方扩展、Codex 或 Bridge 版本门禁。精确 Linux 候选已在普通本地窗口
完成文件读取和 Git 命令，并在 `g1_1` 完成自动 `full-access` 远端只读命令；两条
链路均使用当前 `0.3.33` Shim，Remote Executor 未修改并保持 `0.2.16`。

`0.3.34` 修复了 VS Code transport 在 Controller 主动关闭 socket 时活动请求不终结的
问题。请求此前只监听 `error` 和 `end`，而本地 `destroy()` 只触发 `close`，导致写入
Promise 永久悬空；执行器现在把意外 `close` 映射为断线错误，并继续按副作用语义返回
`RESULT_UNKNOWN`，不盲目重放写入。单元回归覆盖活动副作用关闭。精确 Linux 候选通过
真实 `g1_1` VS Code Remote transport 发起 1 MiB 替换写入后关闭本地 socket，请求在
29 ms 内终结；原文件 SHA-256 不变、临时写入文件为 0，独立后置 thread 再次确认工作
区无残留。原始 1,048,577 字节写入也在 17 ms 内以 `OUTPUT_TRUNCATED` 拒绝。Remote
Executor 实现和协议未修改，继续保持 `0.2.16` / 9。

该外部 CLI 设计不改变运行时权威：官方扩展内置 Codex 仍是唯一 app-server 来源；
外部 Codex CLI 只是客户端，不参与发现或回退，远端也不安装 Codex。

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
`0.2.7` 历史精确版本门禁、真实安装、摘要一致性和主根探针见
`docs/acceptance/2026-07-22-release-0.2.7-executor-version-gate.md`；远程逻辑主根、逐轮
路由和活动 transport 回环见
`docs/acceptance/2026-07-22-release-0.2.7-remote-primary-root.md`。
当前 CLI 持久 MCP 与共享 app-server 候选见
`docs/acceptance/2026-07-23-release-0.3.0-external-cli-mcp.md`。
双向实时同 thread 候选见
`docs/acceptance/2026-07-23-release-0.3.1-bidirectional-cli.md`；Linux Remote SSH
外部 CLI 实机见
`docs/acceptance/2026-07-23-release-0.3.3-remote-cli-acceptance.md`；多上游远端工具
单次执行见
`docs/acceptance/2026-07-23-release-0.3.5-single-tool-execution.md`；外部网关正常关闭见
`docs/acceptance/2026-07-23-release-0.3.6-graceful-gateway-close.md`；设置恢复空闲态见
`docs/acceptance/2026-07-23-release-0.3.8-settings-restore-idle.md`；分阶段重新配置见
`docs/acceptance/2026-07-23-release-0.3.10-staged-reconfigure.md`；历史 thread 恢复见
`docs/acceptance/2026-07-23-release-0.3.11-historical-thread-resume.md`；工具根身份见
`docs/acceptance/2026-07-23-release-0.3.12-root-identity-protocol.md`；本地根授权执行器见
`docs/acceptance/2026-07-23-release-0.3.13-local-root-authority.md`；双端只读路由见
`docs/acceptance/2026-07-23-release-0.3.14-dual-read-routing.md`；运行中命令取消见
`docs/acceptance/2026-07-23-release-0.3.15-command-cancellation.md`；幂等账本见
`docs/acceptance/2026-07-23-release-0.3.16-idempotency-ledger.md`；断线查询恢复见
`docs/acceptance/2026-07-23-release-0.3.17-disconnect-recovery.md`；Core 风险命名空间
阻断见 `docs/acceptance/2026-07-24-release-0.3.18-core-risk-namespaces.md`；双端安全
写入见 `docs/acceptance/2026-07-24-release-0.3.19-dual-write.md`；后台任务见
`docs/acceptance/2026-07-24-release-0.3.20-background-tasks.md`；远程资源见
`docs/acceptance/2026-07-24-release-0.3.21-workspace-resources.md`；双原生产物收集见
`docs/acceptance/2026-07-24-release-0.3.22-native-artifact-collection.md`；外部 CLI
项目写入见
`docs/acceptance/2026-07-24-release-0.3.23-external-cli-workspace-write.md`。
完整能力新对话和 Zklab 单样本见
`docs/acceptance/2026-07-26-release-0.3.26-fresh-conversation.md`；普通本地外部
`full-access` 协议修复及本地/Remote SSH 实机见
`docs/acceptance/2026-07-26-release-0.3.33-local-full-access.md`；VS Code transport
活动关闭终结修复及真实写入中断见
`docs/acceptance/2026-07-26-release-0.3.34-transport-close.md`；本地任务列表隔离见
`docs/acceptance/2026-07-28-release-0.3.44-local-task-list-scope.md`；Remote SSH
任务列表隔离和 g1_1 只读远程操作见
`docs/acceptance/2026-07-28-release-0.3.45-remote-task-list-scope.md`。
远程路由 MCP 工具身份修复见
`docs/acceptance/2026-07-28-release-0.3.46-remote-mcp-tool-guidance.md`；首次配置顺序见
`docs/acceptance/2026-07-28-release-0.3.47-official-extension-bootstrap-order.md`；
Linux 自包含 Shim 见
`docs/acceptance/2026-07-28-release-0.3.48-linux-self-contained-shim.md`；app-server
就绪门槛及最终 Linux 实机分别见
`docs/acceptance/2026-07-28-release-0.3.49-app-server-readiness.md` 和
`docs/acceptance/2026-07-28-release-0.3.49-linux-startup-real.md`。

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
