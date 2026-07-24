# Codex Remote Bridge

这是 `docs/codex-vscode-remote-bridge-requirements.md` 的可行性验证实现。目标是让官方
Codex VS Code 扩展及其内置 app-server 留在可联网的本地 Windows x64 或 Ubuntu x64，
默认复用 VS Code Remote SSH 已认证的远程通道访问离线 Ubuntu 工作区；独立 OpenSSH
执行器保留为回退模式。系统安装的 Codex CLI 不是运行依赖，其版本不会参与 Bridge
发现、选择或回退。

> 当前版本是读操作和受审批非交互命令的技术原型，不是完整 MVP。远程写入、运行中
> 取消和断线恢复尚未完成，不要用于无人值守的生产训练。

## 当前实现

- Bridge 扩展固定声明为 VS Code `ui` 扩展，并提供需求中的 6 个命令。
- 单根 Remote SSH 工作区打开后自动识别主机和根目录、保存配置并连接，无需手动启动。
- 首次接管官方 Codex 设置时自动重载一次；后续打开工作区直接进入 `ready`。
- `chatgpt.cliExecutable` 虽为全局设置，但 Shim 只在 Remote SSH 会话中注入远程策略；
  普通本地窗口保留官方请求语义，仅经过本机共享网关以支持外部 CLI 附着。
- 每个工作区首次就绪时把 Codex Webview 恢复到默认右侧栏，修复旧布局中的灰色面板。
- 修改 `chatgpt.cliExecutable` 和 `remote.extensionKind` 前保存原值，并提供恢复命令。
- 按官方扩展 API 获取当前 `openai.chatgpt` 的安装目录，并只启动对应平台的内置
  Codex；扩展缺失、平台不支持、二进制缺失或版本不匹配时失败关闭。
- Controller 将验证后的插件内置运行时写入受限状态文件，Shim 在本地窗口和 Remote
  SSH 窗口都只读取该指针；旧 `codexExecutable` 配置会被忽略且不再公开。
- Windows 使用 Node SEA 打包的原生 `codex-bridge-shim.exe`，Linux 使用 CJS Shim；
  启动器安装到按版本和内容哈希隔离的本地状态目录，扩展升级后路径仍然有效。
- 自动识别并迁移 Bridge 旧版本或另一平台遗留的 `chatgpt.cliExecutable`，同时只恢复
  Bridge 实际接管过的官方设置，不覆盖用户后来新增的其他扩展映射。
- CLI Shim 代理 app-server JSONL。Remote SSH 会话以本地只读控制目录启动进程，并把
  唯一 `remote/primary` 根登记为线程和每轮请求的 `runtimeWorkspaceRoots`；普通本地
  会话使用原始工作目录且不改写请求，只共享 app-server 生命周期和对话入口。
- 新建和恢复线程注入远程读取、单层/有界目录树、文本搜索、`git status`、受审批命令
  工具和远程策略；每次 turn 通过独立应用上下文刷新远程主根与 `remote_exec` 提醒，
  不覆盖官方扩展已有上下文。
- Bridge 自有工具在返回官方界面前投影为原生 `commandExecution` 项，使用本地 Codex
  相同的读取、列目录、搜索和命令外观，不修改官方扩展文件。
- `remote_exec` 只接受结构化 `argv`；“完全访问”模式不重复询问，其他权限模式使用
  官方命令审批并显示远程主机、规范化 `cwd`、完整命令和环境变量变更。
- stdout/stderr 实时转发；自动放行和人工审批结果都写入本地审计日志。
- 默认 `vscode-remote` 模式自动部署一个不含 Codex 和凭据的 Workspace Executor，
  通过 VS Code Remote Extension Host 执行结构化操作；密码、公钥和 Agent 认证均由
  已建立的 Remote SSH 窗口处理，Bridge 不再发起第二次认证。
- 本地 Shim 与 UI 扩展通过带随机会话令牌的本机 Named Pipe/Unix socket 通信；UI
  扩展再通过 VS Code 命令通道调用远端 Executor。
- 回退 `openssh` 模式使用结构化 `argv`、严格主机密钥校验、连接超时和输出上限。
- 直连主机可单独配置 SSH 用户、端口和可选 IdentityFile；私钥内容不由 Bridge 读取。
- Linux 上同一 `connectionId` 使用受限 ControlMaster 复用，并在停止时显式关闭；
  Windows 为兼容系统 OpenSSH，使用独立 SSH 会话。
- 路径同时经过词法限制和远端 `realpath` 校验，符号链接不能逃逸工作区。
- 远端缺少 `rg` 时自动使用不跟随目录符号链接的 GNU `grep` 搜索。
- SSH 子进程只继承必要环境变量，不继承 Codex、OpenAI 或其他应用凭据。
- 未知 app-server 服务端请求默认拒绝；操作审计日志只保存在本地并结构化脱敏。
- 当前协议子集由实测 `openai.chatgpt@26.721.30844` 内置 Codex
  `0.146.0-alpha.3` 生成；所有版本值只用于诊断、快照索引和回归触发，不作为运行时
  门禁。运行时只因缺少实际能力、消息结构错误或真实操作失败而拒绝。
- Remote SSH 窗口自动扫描本机 Codex MCP：本机能力继续留在本机；满足安全条件的工作区
  stdio MCP 在默认模式下复用当前 VS Code Remote 通道，在回退模式下通过 OpenSSH 中转。
- 可按窗口切换 MCP 访问范围；显式选择 `all` 时启用全部已配置服务、清空工具禁用
  列表，并将服务默认工具审批设为 `approve`，不改写全局 Codex 配置。

## 尚未实现

### 所有待实现功能的实施前置流程

以下流程适用于本节、下方双端读写计划以及其他任务文档中的全部待实现功能。

- [ ] 开始任何待实现功能前，重新汇总 README 与任务文档中的现有清单，标明待实施、
  待验证、受阻和已完成项，并按目标、依赖关系和风险重新排序。
- [ ] 对照目标检查当前实现、协议、测试、审计和相关真实运行链路，记录可复用能力、
  明确能力边界与缺口；涉及 Remote SSH 时必须检查真实远程链路，不得仅凭旧文档或
  构建产物推定运行时已经支持。
- [ ] 完成能力探查后再制定详细实施计划，写明修改范围、实施顺序、验收标准、定向测试、
  发布门禁、真实环境证据、风险和回退方式，并同步更新相关任务文档。
- [ ] 按单项执行“实施、定向自测、更新清单与证据、中文意图提交”的闭环；一个提交只
  处理一个已验证问题，不积压无关改动，缺失的真实环境证据继续标为 `待补测`。

当前重新汇总的任务清单、能力边界和详细实施顺序见
`docs/capability-boundary-plan.md`。

- [x] 将官方 `openai.chatgpt` 扩展及其内置 Codex 设为 Bridge 唯一 app-server 来源；
  系统 `codex` CLI 不再参与发现、版本选择或运行时回退。
- [x] 从插件内置 Codex 生成协议并按内置 app-server 能力建立兼容门禁；官方扩展版本
  不固定，外部稳定版 `0.145.0` 只保留为历史探针，不再是运行或发布依赖。
- [ ] 在真实 Remote SSH 窗口验证当前候选的新建任务、恢复任务、本地窗口共享入口、固定
  远端操作和日志证据；完成前不声明支持当前官方插件组合。
- [x] 面向 Remote SSH 任务在新建、恢复和每次 turn 强化命令路由提醒，明确要求 Codex
  使用 `remote_exec` 执行远程项目命令，并保留官方扩展已有线程指令和逐轮上下文。
- [ ] 在真实官方界面的新建和恢复任务中复核远程主根显示、附件/当前文件以及本地 Shell
  误用为 0；当前 app-server 探针和活动 VS Code transport 回环已经通过。
- [x] 建立适用于全部远端 stdio MCP 的启动适配注册表；通用传输只携带受控适配器
  标识，不复制本机环境或凭据，由远端启动侧解析已审核的参数与环境变化。CodeGraph
  全工具暴露只作为首个适配器和验收样例，不得写成传输层特例。
- 同一任务受控读写本地授权目录和远程工作区，详见下方双端读写计划。
- 运行中命令取消、幂等键、后台任务和断线后结果确认。
- [ ] 对 Codex Core 内置本地 Shell 和文件工具执行前硬阻断。阶段 2C 已让 Remote
  Bridge 会话强制使用本地拒绝权限配置，并在 Shim 边界拒绝 25 个已知本地客户端请求；
  五类 Core 本地审批请求也会直接失败关闭。真实模型对本地诱饵的专用工具负测仍待
  补测，完成前不得开放双端写入。
- 为远程文件提供可打开的资源 URI、Diff 和文件跳转。
- 建立 Windows/Linux 原生构建与受控产物收集流程，避免单端打包删除另一端产物。
- 在目标 Remote SSH 主机和 MimicLite 仓库上的完整 P0 验收。
- [ ] 当前优先实施本地 Codex CLI 对话介入：Bridge 向当前 CLI 对话长期提供 MCP 工具，
  用于列出、读取和介入官方扩展正在进行的 thread，并继续经现有 `remote_exec` 路由
  操作远端；待通用写入协议完成后，再接入受控文件写入。外部 CLI 不成为官方
  app-server 的运行时来源或回退。

Core 本地工具负测与完整 P0 验收仍是阶段 C 的安全门槛。当前 Shim 除了把 app-server
放在本地控制目录并注入远程路由策略，还会强制本地拒绝权限配置、阻断已知本地客户端
请求；但官方明确不保证 hook 覆盖全部专用工具，因此真实诱饵证据补齐前仍不能宣称
Core 强制边界已经闭环。

这里的 Core 本地阻断只用于保证项目操作落到用户选择的远端，而不是额外权限等级；
`full-access` 在远程目标上的命令和后续写入仍应自动放行并记录审计。

远程工作区中的 Codex 可以继续调用本地 app-server 原有的 MCP、App 和 Connector
增强能力，它们无需安装到远端。Bridge 会扫描本机 MCP 配置，但不会修改全局
`~/.codex/config.toml`：HTTP MCP、包含环境变量/本地工作目录的服务和包管理器启动器
继续留在本机；无凭据的直接 stdio 可执行文件只有在远端也存在时才通过当前 Bridge 通道中转。
远端启动器自动探测 `PATH`、`~/.local/bin` 和 `/usr/local/bin`，并以远程工作区为
当前目录。默认 `vscode-remote` 模式由本地 MCP relay、窗口级认证 IPC 和 Remote
Executor 中的长生命周期子进程组成，MCP 字节流与普通远程操作共用已认证的 VS Code
Remote SSH 连接，不再发起第二次 SSH 登录。该通道适用于所有通过安全筛选的直接 stdio
MCP；CodeGraph 只是首个工作区参数适配器，会额外绑定远程索引根目录。可将
`codexRemoteBridge.remoteMcpRouting` 设为 `local`，让所有 MCP 保持本机运行。
`codexRemoteBridge.remoteMcpAccess` 默认为 `enabled`，保留用户已有启用和审批策略；
设为 `all` 后只对当前 Remote SSH 窗口的 app-server 尝试启用已配置 MCP、清空
`disabled_tools`，并设置 `default_tools_approval_mode="approve"`。覆盖会先由同版本
Codex 校验；若插件配置层的局部覆盖会替换 transport，该服务保持原配置，避免拖垮
app-server。服务自身未提供的工具不会被 Bridge 虚构，已有 `enabled_tools` allowlist
或托管策略仍是上层边界。
服务通过私有环境变量或参数控制工具注册时，Bridge 使用代码内共享适配器注册表：
app-server 参数只携带受控适配器 ID，VS Code Remote 由 Executor 在远端解析，
OpenSSH 回退通过 stdin 控制头传递已审核的非凭据变化。不会复制 MCP 配置环境、
本机进程环境或凭据。当前首个适配器在 `remoteMcpAccess=all` 时让远端 CodeGraph
注册八个工具；后续服务复用同一注册、路由和失败关闭接口。

## 本地与远程目录双端读写计划

目标是在同一个 Codex 任务中显式选择并受控访问本地授权目录或当前 Remote SSH
工作区。默认仍复用已建立的 VS Code Remote SSH 通道，不为远程文件操作启动第二次
SSH 认证，也不改写或伪造 VS Code 工作区 URI。以下项目均为 TODO，尚未实现。

### 阶段一：权限边界与协议

- [ ] 定义独立的本地授权根目录，并继续使用规范化的远程 POSIX 工作区根目录。
- [x] Remote Codex 反代启动并识别 Remote SSH 工作区后，将规范化的远程工作区根目录
  登记为 Codex 主工作目录和默认项目上下文；本地控制目录不得冒充项目目录，也不得
  为此改写或伪造 VS Code 工作区 URI。
- [ ] 将本地授权根目录登记为次级工作目录，在任务上下文、双端工具请求、结果和审计
  记录中显式保留主次角色与 `local | remote` 目标端，避免双端读写时混淆目录归属。
- [ ] 为目录树、读取、搜索、状态和写入请求增加显式的 `target: local | remote`，
  不根据路径格式猜测目标端。
- [ ] 明确本地根目录的选择、持久化和撤销流程；配置中不保存密码、私钥、Token 或
  Remote SSH 会话令牌。
- [ ] 本地和远程绝对路径都必须落在各自授权根目录内，禁止通过 `..`、符号链接或
  路径编码逃逸。

### 阶段二：双端文件操作

- [ ] 统一两端的目录树、文件读取、文本搜索和文件状态结果，保留目标端和规范化路径。
- [ ] 增加写入、补丁、创建目录、重命名和删除操作，并为两端返回一致的错误语义。
- [ ] 本地操作由 Bridge Controller 在本地 Extension Host 中执行；远程操作由
  Remote Executor 通过现有 VS Code 命令通道执行。
- [ ] `openssh` 仅保留为用户明确选择的回退路径；默认 `vscode-remote` 模式不得发起
  新的 SSH 登录或密码询问。

### 阶段三：写入安全与审计

- [ ] 修改已有文件前校验调用方读取到的内容哈希，检测并拒绝覆盖并发变更。
- [ ] 使用临时文件和同目录原子替换完成整文件写入，失败时不留下半写文件。
- [ ] 覆盖、重命名和删除等重要操作接入现有审批策略；“完全访问”仍记录自动放行结果。
- [ ] 审计日志记录目标端、规范化路径、操作类型、审批结果、字节数和错误码，但不记录
  文件正文或敏感凭据。
- [ ] 对文件大小、目录项数量、搜索结果和单次写入量设置可测试的上限。

### 阶段四：测试与发布门禁

- [ ] 单元测试覆盖两端路径限制、符号链接逃逸、哈希冲突、权限错误和部分失败。
- [ ] Shim 集成测试覆盖同一任务交替读取和修改本地、远程文件，不把本地路径投影成
  远程路径。
- [ ] 验证远程断线、窗口重载和 Executor 失联时写入安全失败，且不会自动切换到第二次
  SSH 认证。
- [ ] 在真实 VS Code Remote SSH 窗口检查 Codex 日志和 Bridge 审计日志，确认远程操作
  到达 Shim 并被记录为远程执行。
- [ ] 运行定向测试和 `npm run check`，按 `docs/upgrade-tracking.md` 更新发布记录，再
  分别验证 Linux x64 与 Windows x64 的真实运行链路。

完成标准：同一任务可以分别读取和修改本地授权根目录与远程工作区内的文件；越界和
过期写入被拒绝且原文件保持完整；默认远程路径只复用 VS Code Remote SSH transport；
两端操作可从日志中区分并完成审计。

## 当前优先项：外部 Codex CLI 介入

该功能已提升为当前优先批次。Codex CLI 只运行在本地；Bridge 插件提供两种互补入口：
现有 CLI 对话通过持久 MCP 列出、读取和介入 VS Code Codex thread；需要双向实时一致
时，本地 CLI 通过受鉴权的 `--remote` 入口恢复同一个 thread，使 CLI 与 VS Code
同时成为同一 app-server 的客户端。远端仍不安装 Codex。

2026-07-23 已完成官方能力探针：两个独立 WebSocket 客户端可同时初始化同一
app-server；第二客户端能够恢复第一客户端创建的 thread，并对其活动 turn 成功执行
`turn/steer` 和 `turn/interrupt`。因此底层复用官方 thread/turn 并发语义、
`expectedTurnId` 和事件广播；上层由 MCP 提供对话列表、读取、自动选择 steer 或新
turn、取消等稳定工具。Bridge 只负责本机鉴权、请求改写、权限继承、远程路由和审计。

权限以所接入 thread 的 Codex 权限模式为唯一操作权限来源，不另设 Bridge 权限等级。
用户选择 `full-access` 时，外部 CLI 与 VS Code 插件都在已选目标端获得最大操作权限，
写入和命令自动放行并保留审计；其他模式完全沿用 Codex 的分级和审批语义。目标端标识、
并发顺序、幂等和传输路由属于正确性约束，不用于额外降低 `full-access` 权限。

- [x] 探查官方 app-server 多客户端、thread 恢复、turn 追加输入和取消能力；确认
  `codex --remote` 可作为外部客户端入口，不固定外部 CLI 版本。
- [x] 建立仅本机可访问的共享 app-server 网关和短期凭证；外部客户端与官方扩展使用
  独立上游连接，且都经过相同的请求改写、权限继承和远程工具路由。
- [x] 由 Controller 激活时自动注册并随插件升级刷新当前 CLI 的本地 MCP、显式
  `codex-vscode` 入口和 POSIX 普通 `codex` 入口；接管前保存官方启动符号链接的原始
  目标，停用时原样恢复。用户可显式停用或重新启用，不固定 CLI 版本，不把外部 CLI
  纳入 app-server 运行时选择。
- [x] MCP 支持列出和读取当前反代对话，并向指定 thread 自动执行新 turn 或
  `turn/steer`、执行 `turn/interrupt`；Bridge 将各独立上游收到的无 ID 流式通知去重后
  广播给 VS Code 与所有外部客户端，带 ID 的响应和服务端请求仍只返回原连接，不通过
  修改 rollout 文件伪造对话。
- [x] 提供长期自维护的本地附着入口：无参数 `codex` 自动按当前工作目录选择
  唯一活动 VS Code thread，`codex-vscode` 保留显式选择能力，并安全执行
  `codex resume <thread> --remote ...`；令牌只通过子进程环境传递，不进入命令行、
  日志或仓库。
- [x] 自动化验证同一 thread 中来自 CLI 和 VS Code 的输入、流式 item、工具状态、取消
  和最终历史都能实时到达另一端；任一端断开不得终止另一端。普通本地与真实 Remote
  SSH 窗口已验证 CLI 发起 turn、多轮流式通知和工具过程投影；Windows 以及官方 UI
  发起方向的 Remote SSH 取消仍待补测。
- [ ] CLI 发起的项目文件写入必须复用 Bridge 的远程工具、目标端、`expectedHash`、
  原子替换、幂等和审计；审批完全继承 thread 的 Codex 权限模式，`full-access` 不追加
  Bridge 二次确认，但不允许 CLI 绕过插件另开通道写远端工作区。
- [ ] 保留并验证官方 `expectedTurnId`、turn 状态和事件顺序；Bridge 不另加会降低
  `full-access` 能力的单写者租约，协议明确拒绝的并发冲突直接投影给两个客户端。
- [ ] 外部 CLI 的接入、读取、turn 写入、项目写入、审批、取消和断开均记录来源客户端
  与 operation ID；插件 UI 可见并可撤销接入权限。
- [ ] 完成双客户端诱饵、并发、恢复、权限撤销、敏感信息和 Linux/Windows 实机验收，
  再重新执行完整 P0 发布门禁。
- [ ] 完成真实 Remote SSH 剩余闭环：CLI 新建同步 thread、`remote_exec`、远程读取、
  CodeGraph、权限继承、VS Code UI 投影和审计已通过；官方 UI 发起输入、取消、断线、
  附件/当前文件和完整生命周期仍待补测。

本批次已经按“所有待实现功能的实施前置流程”重新汇总清单并完成能力探查；MCP 控制
模式见 `docs/capability-boundary-plan.md` 的阶段 2D，双向实时同 thread 模式见阶段
2E。已经运行的普通 CLI 会话无法原地切换 app-server；首次进入实时模式需要退出并由
托管入口重新附着，之后的输入和事件都留在共享 thread。

Bridge Controller 在 VS Code 激活、配置变化或扩展安装状态变化时自动注册 MCP，并随
插件升级和 Shim 内容地址变化刷新 `~/.local/bin/codex-vscode`；需要迁移运行中 Shim
时自动重载窗口。在 POSIX 上还会安全接管当前 PATH 实际解析到的普通 `codex` 符号
链接。官方 CLI 的绝对入口和原始链接目标保存在权限受限的集成元数据中，子命令、参数
调用和没有活动 Bridge thread 的情况继续透传官方 CLI，停用集成时恢复原链接。已经
运行的 CLI 仍需退出并重新启动一次；它不能热切换到另一个 app-server。当前 CLI 对话
随后可调用：

- `vscode_codex_list_conversations`
- `vscode_codex_read_conversation`
- `vscode_codex_intervene`
- `vscode_codex_interrupt`

进入双向实时模式前只需结束已运行的旧 CLI，然后在对应工作目录重新运行无参数
`codex`；它优先恢复工作目录完全匹配的唯一活动 VS Code thread，只有一个活动会话时
也可自动选择。存在多个歧义会话时会失败关闭，使用对话列表返回的 `sessionPid` 执行
`codex-vscode --session-pid <pid>` 明确选择。启动入口只把网关令牌放入 Codex 子进程
环境，不把令牌写入命令行或配置。

撤销时执行 `Codex Bridge: Disable Automatic CLI Integration`，再重启 CLI 卸载工具；
该选择会持久保留。重新启用可执行
`Codex Bridge: Enable Automatic CLI Integration`。注册只使用系统 CLI 的
`codex mcp` 配置接口，不读取其登录材料，也不改变官方扩展内置 app-server 的运行时
选择。

## 开发与自测

```bash
npm install
npm run check
```

`npm run check` 依次执行 TypeScript 类型检查、单元/集成测试、扩展和 Shim 构建、
本地窗口共享网关与 Remote SSH 窗口初始化、线程列表和线程创建冒烟测试，以及 VSIX
打包。
协议生成和 Shim 冒烟都自动发现最新安装的官方 Codex 扩展，不调用 PATH 或
`~/.local/bin` 中的 Codex CLI。
当前平台的 VSIX 使用 `npm run package`；在 Windows 构建机上可用
`npm run package:all` 同时产出 Windows x64 和 Linux x64 两个目标包。

真实远端只读验收使用环境变量提供目标，不把主机和私钥路径写入仓库：

```bash
CODEX_BRIDGE_REMOTE_TEST=1 \
CODEX_BRIDGE_TEST_HOST=example-host \
CODEX_BRIDGE_TEST_USER=root \
CODEX_BRIDGE_TEST_PORT=22 \
CODEX_BRIDGE_TEST_WORKSPACE=/absolute/remote/workspace \
npm run test:remote
```

需要指定密钥时额外设置 `CODEX_BRIDGE_TEST_IDENTITY=/absolute/local/key/path`。

生成物：

- `dist/codex-bridge-shim.exe`（Windows 构建）
- `dist/codex-bridge-shim.cjs`
- `dist/codex-remote-bridge-<version>-win32-x64.vsix`
- `dist/codex-remote-bridge-<version>-linux-x64.vsix`
- `dist/codex-remote-bridge-executor-<version>-linux-x64.vsix`

它们属于同一个扩展 ID 和同一套源码，只是针对本地 Extension Host 平台的两个分发
产物。Controller VSIX 内嵌匹配版本的远端 Executor，并在 Remote SSH 窗口中通过
VS Code 文件系统和扩展安装服务自动部署。Windows SEA 启动器包含 Node 运行时，因此
VSIX 明显大于 Linux 包，并且当前构建未做代码签名；发布前应加入正式签名流程。

从最新安装的官方扩展内置 Codex 重新生成协议子集：

```bash
npm run protocol:generate
```

生成后必须重新运行 `npm run check`，并更新兼容矩阵。生成清单会记录来源插件版本
作为证据，但不会把该版本写成启动门禁。

## 升级与发布跟进

兼容集合中任一组件升级时，按 `docs/upgrade-tracking.md` 的触发矩阵、硬门禁和量化
指标执行，并从 `docs/acceptance/release-template.md` 创建一份不可覆盖的候选版本记录。
当前基线为 `docs/acceptance/2026-07-18-release-0.2.7.md`。
当前功能候选为
`docs/acceptance/2026-07-23-release-0.3.1-bidirectional-cli.md`；在真实 Remote SSH
双向对话闭环通过前，它不会替代已验收基线。

Windows x64 和 Linux x64 必须分别填写运行结果。`npm run package:all` 能证明两个目标
VSIX 已生成并完成平台内容隔离，但不能用 Windows 构建机上的 Linux 包替代 Linux 本地
Extension Host、CJS Shim、官方任务创建和真实 Remote SSH 验收。缺少的数据写
`待补测`，并限制兼容性声明范围。

## 试用流程

1. 按本地平台安装对应 VSIX：Windows 使用 `win32-x64`，Ubuntu 使用 `linux-x64`。
2. 用 Remote SSH 打开单个远程工作区。
3. Bridge 自动保存当前主机和根目录、部署远端 Executor；首次接管设置或安装
   Executor 时窗口会自动重载。
4. 等待状态栏显示 `Codex: local -> <host> (ready)`。
5. 运行 `Codex Bridge: Run Diagnostics`，确认本地扩展宿主、官方设置、远端身份和
   `remote.codexInstalled=false`。
6. 需要全部 MCP 时，将 `codexRemoteBridge.remoteMcpAccess` 设为 `all` 后完整重启
   VS Code；审计中的 `remoteMcpAccess` 应为 `all`。
7. 新建 Codex 任务，验证远程读取、目录树、搜索、`git status` 和 MCP 工具。
8. 请求执行 `pwd` 或仓库测试命令；“完全访问”应直接执行，其他模式应显示审批。
9. 停用原型前执行 `Codex Bridge: Restore Official Codex Settings`；该命令同时关闭
   `codexRemoteBridge.autoInitialize`，避免重载后再次接管。

自动流程仅在 `codexRemoteBridge.autoInitialize=true`、当前窗口为 Remote SSH 且恰好
打开一个远程根目录时运行。关闭该设置后仍可使用 Configure 和 Start 命令手动控制。
普通本地工作区即使同时打开，也不会读取远程 Bridge 配置或重写 app-server 消息；
它只经过本机共享网关，以便 `codex-vscode` 附着当前官方 thread。

本地配置和审计日志的默认位置如下：

- Windows：`%APPDATA%\codex-remote-bridge\config.json` 和
  `%LOCALAPPDATA%\codex-remote-bridge\audit.jsonl`。
- Linux：`~/.config/codex-remote-bridge/config.json` 和
  `~/.local/state/codex-remote-bridge/audit.jsonl`。

Remote SSH 窗口会额外创建按本地 Extension Host PID 隔离的会话配置；其中只保存
本机 IPC 端点和随机会话令牌，不保存 SSH 密码、私钥或 OpenAI Token。默认连接模式为
`vscode-remote`；需要独立连接时可选择 `openssh`，Windows 会自动发现系统 OpenSSH，
也可通过 `codexRemoteBridge.sshExecutable` 指定路径或命令名。
Codex Core 会清理 stdio MCP 子进程的 `CODEX_BRIDGE_*` 环境变量，因此 Bridge 会把该
会话配置文件的绝对路径作为 `mcp-proxy --session-config` 参数传递；随机令牌仍只存放在
受限文件中，不进入进程命令行。

更多边界与验收信息见 `docs/implementation-status.md`、`docs/compatibility.md`、
`docs/upgrade-tracking.md` 和 `docs/security-notes.md`。
