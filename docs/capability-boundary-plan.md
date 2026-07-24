# 当前能力边界与实施计划

更新日期：2026-07-23

本文重新汇总所有待实现、待验证和待补测事项，并基于当前源码、协议、测试、审计日志
和活动 Remote SSH 窗口划定能力边界。后续新增功能必须按本文顺序实施；每个阶段都要
完成定向自测、任务文档同步和独立中文意图提交。

本文是实施基线，不改变 `docs/compatibility.md` 的支持声明。没有完成官方任务创建、
真实远程操作或双平台实机验证的项目继续标为 `待补测`。

## 1. 本次复核快照

### 1.1 当前组件

| 组件 | 2026-07-23 实测值 | 当前结论 |
| --- | --- | --- |
| 本地平台 | Linux x64 | 可执行 Linux Controller 自动化与打包 |
| VS Code | `1.130.0` | Remote SSH 外部 CLI 同步任务已实测；官方面板发起待补测 |
| 官方 Codex 扩展 | `openai.chatgpt@26.721.30844` | 普通本地与 Remote SSH 外部 CLI 双向投影通过；官方面板发起待补测 |
| 官方扩展内置 Codex | `0.146.0-alpha.3` | 当前唯一 app-server 来源；版本仅作诊断和协议快照索引 |
| 系统 Codex CLI/app-server | 任意或未安装 | 不属于运行时兼容集合；外部对话控制仅把当前 CLI 作为可选 MCP 客户端，不固定版本 |
| Bridge Controller | `0.3.3` 候选 | 无版本值门禁；空 thread 回退、Remote SSH 多轮与工具打印已实测 |
| Remote Executor | `0.2.8` 候选 | 按所需能力集合握手；远端命令、读取和 stdio CodeGraph 已实测 |
| Remote SSH | `0.124.0` | 活动 transport、远程主根和外部 CLI 双向链路通过 |

仓库不固定或门禁任何组件版本；当前生成协议记录的来源扩展为 `26.721.30844`，诊断
快照键为 `codexProtocolSnapshotVersion=0.146.0-alpha.3`，协议位于
`protocol/0.146.0-alpha.3/`。Controller 只接受通过官方扩展 API 定位的内置二进制；
Shim 从受限运行时指针读取同一二进制。扩展和 Codex 版本字段允许未知或变化；只有
二进制缺失、能力缺失、消息结构错误或真实操作失败才拒绝，不会探测系统 CLI。

### 1.2 当前自动化证据

2026-07-23 在 Linux x64 本机执行 `npm run check`：

- TypeScript 类型检查通过。
- 37 个测试文件通过，1 个真实远端条件测试文件跳过。
- 157 项测试通过，5 项真实远端条件测试跳过，0 项失败。
- Controller、Shim 和 Remote Executor 构建通过。
- 插件内置 `0.146.0-alpha.3` 的本地透传、远程窗口启动和线程创建 Shim 冒烟通过；
  缺少受控运行时指针时，即使 PATH 存在系统 CLI 也失败关闭。
- Linux x64 Controller VSIX 和匹配的 Remote Executor VSIX 打包通过。

这些结果证明当前源码自动化基线与 Linux 包构造可用；真实窗口另外证明了外部 CLI
发起的 Remote SSH 同步任务、远端命令/读取和 CodeGraph。它们仍不证明官方面板发起
的新任务、远程命令取消、断线恢复、双端读写或完整生命周期。

随后补跑 `npm run package:all` 时，Linux 主机因没有 Windows 构建生成的
`dist/codex-bridge-shim.exe` 而失败。当前打包脚本不能在单一 Linux 工作区独立重建
双平台 Controller；Windows 包必须由 Windows 构建产出并进入受控收集流程。

### 1.3 当前真实窗口证据

活动 VS Code Remote SSH 窗口已连接 `g1_1`，工作区为
`/home/unitree/mimiclite-sim2real`。安装 `0.3.3` 并由用户重载后，当前日志和实机
操作证明：

- Controller 自动迁移托管 Shim 并自动重载，随后复用唯一活动的 VS Code Remote SSH
  transport 进入 `ready`；远端没有安装或启动 Codex。
- 初始 VS Code thread 尚未物化，无法 `resume`。`codex-vscode` 已按错误能力信号
  自动回退为新建同步 thread，而不是报 `no rollout found` 后退出。
- 外部 TUI 在 YOLO 模式连续完成两轮，打印 `remote_exec pwd`、README 读取和远端
  CodeGraph `codegraph_status` 的调用过程与结果。
- 审计确认 `full-access` 自动放行，没有 Bridge 二次审批；外部连接向 VS Code 主
  客户端转发 141 条通知。
- 官方 Codex 日志和结构化读取确认同一 thread 在 UI 侧活动，包含 2 个完成的 turn。

该证据完成了 Linux Remote SSH 外部 CLI 限定链路验收，但不能替代官方面板按钮发起
的新任务、取消、断线、附件、当前文件、完整生命周期或 Windows x64 验收。详见
`docs/acceptance/2026-07-23-release-0.3.3-remote-cli-acceptance.md`。

### 1.4 外部 `0.145.0` 探针与插件内置协议

本次先在临时目录生成 Schema 并完成差异审查，随后将原 `~/.local` 安装、本仓库精确
版本门禁和协议子集升级到 `@openai/codex@0.145.0`。相对 `0.144.5`：

- `ServerRequest` 方法仍为 11 个，没有新增或删除请求方法。
- `DynamicToolCallParams` 和 `InitializeParams` 的结构不变。
- `DynamicToolCallResponse` 新增 `inputAudio` 内容项。
- `ThreadStartParams` 的 turn 环境正式增加 `runtimeWorkspaceRoots`。
- `ThreadResumeParams` 的内容项增加音频输入形态。
- 文件系统特殊路径的 `subpath` 改为引用 `LegacyAppPathString`。

该稳定版结果现只作为历史协议探针。最终候选改由
`openai.chatgpt@26.715.61943` 内置 `0.145.0-alpha.27` 生成：

- `ServerRequest` 方法仍为 11 个，失败关闭白名单无需扩展。
- `DynamicToolCallParams`、`DynamicToolCallResponse`、`InitializeParams` 和
  `ThreadResumeParams` 与 `0.144.5` 快照一致。
- `ThreadStartParams` 包含 `runtimeWorkspaceRoots`，后续用于远程逻辑主根探针。
- 协议生成、缺少运行时指针的失败关闭、真实 app-server 冒烟和 Linux 候选打包已通过；
  当时的内置版本门禁已经由 `0.3.2` 废止。

当前扩展的外部 CLI 同步任务、MCP、固定远端探针和真实 Remote SSH 链路已经重跑；
官方面板按钮发起的新任务和完整生命周期仍使该版本保持候选状态。

## 2. 重新汇总的任务清单

| ID | 任务 | 当前状态 | 已有能力 | 主要缺口 |
| --- | --- | --- | --- | --- |
| RUNTIME-OFFICIAL | 仅依赖官方扩展内置 Codex | 已实施 | Controller 只从官方扩展 API 定位内置二进制；本地和 Remote SSH 实机均未启动系统 Codex 服务端 | 官方面板发起的新任务待验证 |
| RUNTIME-PASSTHROUGH | 本地窗口使用插件内置 Codex且请求语义不变 | 已实施并实测 | Shim 使用受限运行时指针并在缺失时失败关闭；共享网关保持本地语义，Remote SSH 外部 CLI 权限继承通过 | 官方面板任务和完整生命周期仍待验证 |
| COMP-BUNDLED | 为插件内置 app-server 生成协议 | 已实施 | 版本仅作诊断；协议快照、结构差异、自动化和升级后自动迁移已同步 | 官方面板和 Windows 实机待验证 |
| COMP-145 | 适配外部 Codex `0.145.0` | 历史完成后被取代 | 当时的 CLI、协议、版本门禁、测试、Shim 冒烟和 Linux 候选包已完成 | 版本门禁已在 `0.3.2` 废止 |
| COMP-OFFICIAL | 验证 `openai.chatgpt@26.721.30844` | Linux 限定链路实机通过 | 协议、Shim、普通本地、Remote SSH 外部 CLI、权限和远端工具通过 | 官方面板任务、完整生命周期和 Windows 待补测 |
| ROUTE-EXEC | 强化 Remote SSH 下的 `remote_exec` 路由 | 已实施 | 新建/恢复线程注入策略，每次 turn 通过独立上下文键刷新提醒，动态工具描述明确 | Core 本地工具硬阻断仍属于 SAFE-CORE |
| MCP-ADAPTER | 通用远端 MCP 启动适配 | 已实施 | 受控适配器 ID、共享注册表、VS Code Remote/Remote Executor 与 OpenSSH stdin 控制头均已实现；CodeGraph 八工具实机通过 | 其他服务适配器和 OpenSSH 回退实机仍待按需补充 |
| ROOT-PRIMARY | 远程工作区成为主工作目录 | 已实施并限定实测 | 配置 v2 固定唯一 `remote/primary`；线程以本地控制目录为物理 `cwd`，以远程主根为逻辑 `runtimeWorkspaceRoots`；外部 CLI 新建同步 thread 的命令和读取默认落到远程主根 | 官方面板新建/恢复、附件和当前文件仍待补测 |
| ROOT-SECONDARY | 定义本地次级授权目录 | 部分实施 | 配置 v2 已定义并校验 `local/secondary` 根记录，但尚未提供授权入口 | 没有本地根选择、执行器、访问和撤销协议 |
| DUAL-READ | 双端目录读取、树、搜索和状态 | 待实施 | 远端只读工具完整；Remote Executor 有路径约束 | 工具没有 `target`；Controller 没有本地授权目录执行器 |
| DUAL-WRITE | 双端写入、补丁、重命名和删除 | 待实施 | 读取结果已返回远端 SHA-256 | 没有写工具、`expectedHash`、原子替换或统一错误语义 |
| LIFE-CANCEL | 运行中取消 | 待实施 | 执行器底层接受 `AbortSignal`，超时能终止子进程 | app-server `turn/interrupt` 没有传到活动远端请求 |
| LIFE-IDEMP | 幂等和断线结果确认 | 待实施 | 有 `callId`、`requestId`、`connectionId` 和 `RESULT_UNKNOWN` | 没有幂等账本、结果查询、重连确认或去重 |
| LIFE-BACKGROUND | 后台任务 | 待实施 | MCP stdio 有长生命周期会话管理 | 普通命令没有 start/status/log/cancel 协议 |
| SAFE-CORE | Core 本地 Shell/文件工具硬阻断 | 部分实施/待补测 | 专用本地拒绝权限配置已由官方 app-server 激活；Shim 阻断 25 个本地客户端请求和五类 Core 本地审批并失败审计 | 真实模型专用工具诱饵负测和官方 UI 恢复尚未完成；hook 不能作为完整强制边界 |
| UX-REMOTE | 远程 URI、Diff 和文件跳转 | 待实施 | Bridge 工具可投影为原生 command item | 没有可打开的远程资源身份和 Diff 提供器 |
| PACK-DUAL | 双平台产物构建与收集 | 待实施 | 两个平台分别有原生 Shim 构建逻辑 | Linux 无法生成 Windows SEA，`package:all` 依赖预存 `.exe` |
| VERIFY-P0 | 完整 P0 验收 | 待补测 | 历史 Windows 到 Ubuntu 主链路有部分证据 | 当前兼容集合、取消、写入、安全失败和诱饵文件未闭环 |
| VERIFY-LIFECYCLE | 设置恢复和进程清理 | 待补测 | 逻辑测试覆盖设置恢复；停止时会关闭部分资源 | 三种关闭方式、遗留进程和断线行为缺少实机证据 |
| VERIFY-METRICS | 量化指标 | 待补测 | 已有单样本和门禁模板 | 启动、任务、固定探针和 MCP 未达到最低样本数 |
| CLI-INTERVENE | 当前 Codex CLI 对话控制 VS Code Codex 对话 | Linux 本地与 Remote SSH 实机通过 | 共享网关、持久 MCP、list/read/intervene/interrupt、跨客户端权限跟踪和真实远端工具链路已实现 | 已运行的旧 CLI 不会热加载；Windows 和剩余生命周期待补测 |
| CLI-BIDIRECTIONAL | CLI 与 VS Code 双向实时共享同一 thread | Linux 本地与 Remote SSH 实机通过 | 长期自维护入口、空 thread 新建回退、全双工流式事件、工具打印、权限继承、取消和断开已实现 | 当前旧 CLI 必须重启；官方 UI 发起方向的 Remote SSH 取消与 Windows 待补测 |

## 3. 已有能力边界

### 3.1 版本和协议

已有：

- `scripts/generate-protocol.mjs` 自动从最新安装的官方扩展内置 Codex 生成受控协议
  子集；仅开发测试允许显式路径覆盖。
- `test/protocol-compatibility.test.ts` 会逐项比对已知服务端请求，遇到新请求失败关闭。
- Controller 与 Shim 都会验证插件内置 app-server 协议；官方扩展版本只记录不固定。
- 系统 CLI 发现代码、公开路径设置和无指针回退均已删除。

边界：

- 运行时指针由 Controller 原子写入本地状态目录；普通本地窗口依赖该指针，因此首次
  安装或插件升级后需要先激活或重载 Bridge。
- 当前包不钉住官方扩展版本；只有实际所需能力或消息结构不兼容时才会被拒绝。
- 官方扩展版本变化会改变项目校验和任务创建行为，协议测试不能替代官方 UI 验收。

### 3.2 Codex 提醒和工具路由

已有：

- `thread/start` 注入 `remote_*` 工具和远程执行策略。
- `thread/resume` 重新注入远程策略。
- 策略明确要求项目命令使用 `remote_exec`，禁止回退到本地 Shell 和文件系统。
- 未配置 Bridge 时动态远程工具调用会失败关闭。

边界：

- `turn/start` 没有独立的 `developerInstructions` 字段，不能沿用线程级注入方式。
- `0.145.0-alpha.27` 的 `TurnStartParams.additionalContext` 可承载逐轮应用上下文；实施时
  使用独立的 `codex-remote-bridge` 键合并提醒，不覆盖官方扩展已有上下文。
- 提醒只能影响模型选择，不能阻止 Core 内置本地 Shell 或文件工具。
- Shim 只接管 `item/tool/call` 中的 Bridge 动态工具；Core 内置工具不经过
  `DynamicToolRouter`。

### 3.3 工作目录和主次角色

已有：

- `BridgeConfig.roots` 记录稳定根 ID、目标端、主次角色、规范化路径和显示名。
- 配置中必须且只能存在一个 `remote/primary`；`BridgeConfig.workspaceRoot` 是该主根的
  运行期兼容别名，二者不一致时失败关闭。
- v1 单远程根配置会无损迁移为 v2；v2 可记录但尚不能访问 `local/secondary`。
- `remote_exec.cwd` 是远程工作区相对路径，缺省时由执行器落到远程根目录。
- 远端文件、搜索、Git 和命令都在规范化远程根目录内执行。

边界：

- 本地 app-server 进程必须在本机存在的控制目录中启动。
- 当前 `thread/start`、`thread/resume` 和 `turn/start` 仍把 `cwd` 与
  `runtimeWorkspaceRoots` 都改成本地控制目录；阶段 2B 将只保留 `cwd` 为控制目录。
- 远程根目录目前只存在于 Bridge 配置、提示和动态工具中，不是 Codex 线程的逻辑主根。
- `localExecution` 仍固定为 `deny`；配置中的本地次级根没有选择入口或执行器，不能
  被工具访问。

实现“远程主工作目录”时必须区分：

1. **本地进程目录**：本地 app-server 可启动的空控制目录。
2. **逻辑主工作目录**：当前 Remote SSH 工作区根目录，是项目工具的默认目标。
3. **次级工作目录**：用户显式授权的本地目录，只能通过带目标端的 Bridge 工具访问。

不能把本机不存在的远程 POSIX 路径直接当作 app-server 进程 `cwd`，也不能改写或伪造
VS Code 工作区 URI。2026-07-22 对官方扩展内置 `0.145.0-alpha.27` app-server 的无副作用
探针确认：

- `initialize.capabilities.experimentalApi=true` 后，`thread/start` 接受
  `/home/unitree/mimiclite-sim2real` 作为 `runtimeWorkspaceRoots`，同时保留本地控制目录
  为 `cwd`；不要求该远程路径存在于本机。
- `thread/resume` 接受同一组远程绝对路径并继续进入线程查找；临时探针线程没有 rollout，
  因此恢复止于预期的 `no rollout found`，不是路径或协议拒绝。
- `turn/start` 接受远程 `runtimeWorkspaceRoots`、本地只读 sandbox 和逐轮应用上下文，
  并产生 `turn/started`；探针使用空白 `CODEX_HOME` 且立即结束，不访问模型或远端文件。

因此阶段 2B 选定“本地控制目录作为进程 `cwd`，唯一 `remote/primary` 作为
`runtimeWorkspaceRoots`”的双层语义，不采用工作区 URI 合成、路径伪装或远程路径作为
本地进程目录。

### 3.4 远程文件和双端访问

已有：

- 远端文件读取返回内容、规范化路径、大小、模式、修改时间和 SHA-256。
- 目录、目录树、搜索和 Git 状态均有结构化工具。
- 词法路径与远端 `realpath` 双重校验，能拒绝符号链接逃逸。
- 默认 `vscode-remote` 模式通过 Remote Extension Host 执行，不发起第二次 SSH 登录。

边界：

- `REMOTE_DYNAMIC_TOOLS` 全部是 `remote_*`，没有统一的 `target: local | remote`。
- `LocalProcessExecutor` 名称中的“Local”是指在远端 Extension Host 本机执行，不是
  Controller 本地主机的授权目录执行器。
- Controller 仅为安装 Executor 使用 `vscode.workspace.fs`，没有通用本地文件工具。
- 没有写入、补丁、创建目录、重命名、删除和哈希冲突处理。

### 3.5 命令、审批和输出

已有：

- `remote_exec` 仅接受结构化 `argv`，Shell 语法必须显式使用 Shell 入口。
- `cwd`、环境变量变化、超时和输出上限都有参数边界。
- 非完全访问模式使用官方命令审批；完全访问模式自动放行但仍写审计。
- stdout/stderr 以官方 `commandExecution` 输出增量形态转发。
- 超时或断线后的有副作用操作会返回 `RESULT_UNKNOWN`，不会自动本地重试。

边界：

- 所有 `remote_exec` 都按有副作用操作处理，无法声明纯读取命令。
- 没有进程组或远端作业标识，终止单个父进程不保证清理完整进程树。
- 没有稳定幂等键；相同 `callId` 再次出现仍可能重复执行。
- 审批通过后参数不可变由当前调用对象保证，但没有跨重连审批摘要。

### 3.6 取消、断线和后台任务

已有：

- OpenSSH 和 Remote Extension Host 执行器内部都实现了 `AbortSignal` 处理。
- 执行超时会发送 `SIGTERM`，随后尝试 `SIGKILL`。
- VS Code transport 断开时，有副作用请求在本地返回 `RESULT_UNKNOWN`。
- MCP stdio 会话支持 start/write/end/stop 和窗口关闭清理。

边界：

- `turn/interrupt` 当前透明转发给 app-server，没有关联 `turnId` 下的活动 Bridge 调用。
- `VsCodeRemoteExecutor` 的 abort 只关闭本地 socket；Controller 没有发送远端 cancel，
  Remote Executor 也没有按请求 ID 保存 `AbortController`。
- socket 断开后 Remote Extension Host 中的命令可能继续运行到完成或超时，输出被丢弃。
- 没有完成结果账本，恢复连接后无法判断旧副作用是否完成。
- 普通命令没有后台作业协议；MCP stdio 生命周期不能直接复用于任意训练命令。

### 3.7 Core 本地工具阻断

已有：

- app-server 被放在空且只读的本地控制目录。
- Remote Bridge app-server 定义并默认选择 `codex-remote-bridge` named permission
  profile；线程新建、恢复、设置更新、fork 和 turn 都重新锁定该 profile、
  `approvalPolicy=never` 与本地控制 `cwd`。
- profile 对 `:root` 拒绝、仅放行 `:minimal` 运行时读取并禁用网络；真实官方
  app-server 返回 `activePermissionProfile.id=codex-remote-bridge`、只读 sandbox
  和无网络。
- Shim 在 app-server 前阻断 25 个已知 `thread/shellCommand`、后台终端、`fs/*`、
  `command/exec*`、`process/*` 和 `fuzzyFileSearch*` 请求，只审计方法名。
- Core 发起的本地命令、文件、权限和两类旧协议审批在到达官方 UI 前直接失败关闭；
  Bridge 自己生成的远程 `remote_exec` 审批不走这些方法，不受影响。
- 开发者指令要求项目操作只使用远程工具。
- 本地 Core 阻断用于固定执行目标、防止把远程项目误操作到本机控制面，不是第二套权限
  分级；远程目标上的 `full-access` 仍自动放行。

边界：

- 协议阻断覆盖客户端直达请求，但模型在 app-server 内部调用的专用工具不经过该边界，
  仍依赖 permission profile 和真实负测。
- 当前 Linux 环境的直接文件诱饵探针在进入路径检查前被 `bwrap` 环回网络初始化失败
  阻断，不能把该失败当作文件拒绝命中。
- 当前控制目录未被信任，项目级 `.codex` hooks、规则和配置不会加载。

Codex `0.145.0` 的权限配置和 `PreToolUse` hooks 提供可探查的防线：权限配置可限制本地
文件系统，hook 可观察并拒绝常见 Shell、`apply_patch`、MCP 和本地函数工具。但官方
文档同时说明部分专用工具可以绕过默认 hook 路径，因此 hook 只能作为纵深防御，不能
单独作为完整 Core 强制边界。若权限配置与 hook 组合仍不能证明错误本地项目操作为零，
必须评估开源 Codex Core 修改或独立客户端路线。

### 3.8 审计、UI 和发布证据

已有：

- 审计记录请求、连接、主机、工作区、操作、结果、耗时和脱敏错误。
- Bridge 工具结果可投影为官方命令执行、读取、目录和搜索外观。
- `docs/upgrade-tracking.md` 已定义版本触发矩阵、G0-G9 门禁和最低样本数。

边界：

- 审计没有 `target`、主次角色、写入字节数、冲突结果、幂等命中或取消确认字段。
- 远程文件没有稳定的可打开 URI、Diff 或跳转提供器。
- `package:all` 不是跨平台编译器；Linux 构建会删除 Windows SEA，不能单机重建完整
  双平台发布目录。
- 当前发布证据主要是旧 Windows 基线；本次 Linux 探查不能覆盖未执行的人工链路。

### 3.9 远程 MCP 访问与服务适配

已有：

- `remoteMcpAccess=all` 对当前 app-server 的全部已配置 MCP 统一注入
  `enabled=true`、`disabled_tools=[]` 和默认批准策略。
- 通用 stdio relay 复用活动 VS Code Remote SSH transport，能够中转任意通过安全筛选
  的 MCP 字节流，不依赖 CodeGraph 协议。
- MCP 服务名、远端可执行文件、参数和工作区根都经过约束；本机 MCP 环境变量、凭据和
  本地 `cwd` 不会自动复制到远端。

边界：

- MCP 协议没有统一的“注册全部工具”请求；Bridge 的访问策略只能开放服务实际通过
  `tools/list` 注册的工具。
- 不同服务可能使用自己的环境变量、启动参数或配置文件控制工具注册，不能靠一个通用
  环境变量解决，也不能把未知本机环境原样转发。
- 当前 CodeGraph 远端进程默认只注册 `explore`；历史探针证明设置其服务私有工具列表
  后可注册全部八个工具，但项目还没有通用适配器注册与远端解析链路。
- `openssh` 回退和 `vscode-remote` 默认通道必须使用同一适配器语义；适配值不得出现在
  app-server 参数、进程命令行或审计日志中。

## 4. 实施原则

1. 官方 `openai.chatgpt` 扩展及其内置 Codex 是唯一 app-server 来源；系统 Codex CLI
   可不存在或保持任意版本，不参与发现、选择、透传和回退。
2. 默认复用活动 VS Code Remote SSH transport；除非用户明确选择，不启动 OpenSSH 回退。
3. 本地进程 `cwd` 与远程逻辑主工作目录分开建模，不伪造 VS Code 工作区 URI。
4. 每个目录根都携带稳定 ID、`target`、`role` 和规范化路径，不根据路径样式猜测目标端。
5. 远程主根是默认项目目标；本地次级根必须由用户显式选择、授权和撤销。
6. 双端写入必须与 `expectedHash`、原子替换、审批、审计和幂等一起交付。
7. 运行中取消、断线结果确认和幂等先于后台训练任务。
8. 提示和 hook 只算纵深防御；安全声明必须由不可绕过的执行边界和诱饵测试证明。
9. 每个兼容集合变化都创建独立候选记录，Windows/Linux 实机结果分别填写。
10. 外部 Codex CLI 对话介入提升为阶段 2D，先于其余待实现功能交付；它仍只作为
    本地客户端，不替代官方扩展内置 app-server，也不成为运行时发现或回退来源。
    通用项目文件写入继续等待阶段 5，禁止为赶进度另开写入旁路。
11. 当前 thread 的 Codex 权限模式是 Bridge 命令、文件写入和外部 CLI 介入的唯一操作
    权限来源；`full-access` 在已选目标端自动放行并只保留审计，其他模式沿用 Codex
    分级和审批。Bridge 不再叠加第二套权限等级。
12. MCP 介入属于控制面，不得宣传为对普通 CLI 会话的实时镜像。双向实时体验必须让
    CLI 与 VS Code 直接恢复同一 app-server/thread；不得通过复制 rollout 或重复调用
    模型伪造同步。

## 5. 详细实施计划

### 阶段 1：官方扩展内置 Codex 兼容基线

目标：将版本权威从系统 Codex CLI 切换为当前官方扩展及其内置 app-server，不同时
引入双端读写。

前置证据：外部稳定版 `0.145.0` 候选提交 `a3162cf` 已证明现有代理可适配该协议，
但它不再是最终运行时来源。当前官方扩展 `26.715.61943` 内置
`0.145.0-alpha.27`，其服务端请求方法集合仍为已知 11 项。

实施：

1. 从官方扩展 API 获取当前扩展版本、安装目录和平台内置 Codex 路径；缺少扩展、平台
   不支持或二进制不存在时失败关闭。
2. Controller 的配置、恢复、诊断和启动都覆盖旧持久化路径，只接受当前官方扩展内置
   二进制；删除公开的 `codexExecutable` 设置。
3. 为 Shim 保存受控的内置运行时指针，使普通本地 VS Code 窗口也透传到插件内置
   Codex；指针缺失或失效时不得回退系统 CLI。
4. 协议生成和 Shim 冒烟默认发现插件内置 Codex，开发测试仅允许显式环境变量覆盖。
5. 针对内置版本重新生成协议，保持 11 个服务端请求的失败关闭白名单，并审查动态工具
   结果、恢复历史、工作区根和审批字段差异。
6. 增加 Linux/Windows 路径解析、外部 CLI 诱饵、旧配置迁移、本地透传和插件升级路径
   测试，证明系统 CLI 不会被选择。
7. 运行定向测试、`npm run check`、当前平台打包和包内运行时/协议核对。
8. 安装候选 VSIX 后，由用户在真实 Remote SSH 窗口完成连接、必要重载和新任务创建。
9. 复核 Codex 日志与 Bridge 审计，确认使用插件内置版本、任务到达 Shim、项目操作走
   远端且普通本地窗口正常透传。

当前进度：第 1-5 项已完成；第 6 项已覆盖双平台路径、旧配置忽略、受限指针和无指针
失败关闭，插件升级实机链路仍待补测；第 7 项的 Linux x64 自动化与当前平台包已完成，
Windows 原生包仍待补测；第 8-9 项等待用户在真实 Remote SSH 窗口操作后闭环。

验收：

- 安装或升级系统 Codex CLI 不改变 Bridge 选择结果；删除系统 CLI 后自动化与真实窗口
  仍能工作。
- 官方扩展更新后重新发现内置二进制；协议不匹配时进入 `incompatible`，不回退 CLI。
- 当前官方扩展新建、恢复和 turn 均无 `Unknown local project`。
- 未完成真实窗口任务创建前，兼容矩阵不得写成支持当前插件组合。

提交边界：

- 运行时发现、旧配置迁移和 CLI 回退删除一个提交。
- 插件内置协议生成与自动化适配一个提交。
- 真实验收证据和兼容矩阵一个文档提交。

### 阶段 1A：通用远端 MCP 启动适配

目标：保留统一的 MCP 访问控制和 stdio 传输，在不复制未知本机环境的前提下，为服务
私有的远端启动差异提供可复用、可验证的适配机制。

实施：

1. 定义共享的适配器注册表；适配器以稳定 ID 描述适用的服务名、远端可执行文件、
   访问模式以及经过审核的启动变化。
2. MCP 路由器只选择适配器并把不含秘密的 ID 交给 relay；不得把环境变量值写入
   app-server 参数、进程命令行或审计。
3. `vscode-remote` 的 Remote Executor 和 `openssh` 启动器分别在远端启动点解析同一
   适配器 ID；未知 ID、服务不匹配或参数不匹配必须失败关闭。
4. 适配器只能返回代码内已审核的非凭据环境变化和安全参数；不读取或复制 MCP 配置的
   `env`、`env_vars`、本机 `cwd`、Token 或进程环境快照。
5. 将 CodeGraph 的完整工具注册作为首个适配器；工作区 `--path` 继续由已有参数适配
   负责，工具列表只在 `remoteMcpAccess=all` 时启用。
6. 升级 Remote Executor 协议与版本，覆盖路由、解析、远端进程环境、拒绝路径和
   OpenSSH 等价语义测试。
7. 运行定向测试、`npm run check` 和当前平台打包；安装候选后等待用户手动重载
   Remote SSH 窗口。

当前进度：第 1-7 项已完成。实现提交为 `196b272`；Linux x64 候选在真实 `g1_1`
Remote SSH 窗口进入 `ready`，官方 Codex 新任务通过
`mcp__codegraph.codegraph_status` 读取 93 个索引文件，并通过
`functions.remote_exec` 在远端主目录执行 `pwd`。OpenSSH 回退实机和 Windows x64
仍待补测。

验收：

- `remoteMcpAccess=all` 下，真实远端 `tools/list` 返回 CodeGraph 八个工具，
  `codegraph_status` 可调用；工作区未初始化时返回服务的真实未初始化状态。
- `remoteMcpAccess=enabled` 不擅自扩大服务注册面。
- 未知适配器、错误可执行文件和服务不匹配均被拒绝。
- app-server 参数、Bridge 审计、Codex 日志和远端进程命令行均不出现适配器环境值。
- 适配器机制不依赖 CodeGraph 字节流，后续服务可复用相同注册、路由和验证接口。

风险与回退：

- 服务升级可能改变私有工具名；升级门禁必须重新执行 `tools/list`，不沿用旧结果。
- Remote Executor 协议不匹配时保持 `incompatible` 并重新部署，不降级为未验证环境
  转发。
- 任一适配失败时保持服务原配置或本机运行；删除适配器选择即可回退，不修改全局
  Codex MCP 配置。

提交边界：

- 适配器注册表、双通道路由和安全拒绝一个实现提交。
- 当前平台包与真实 Remote SSH 证据一个验收提交。

### 阶段 2：远程主工作目录、路由刷新与 Core 防线探针

目标：建立主次目录语义，并在开放本地次级目录前证明项目操作默认只走远端。

当前落实批次（阶段 2A，2026-07-22）：

1. 先将持久化和窗口会话配置升级为 v2 根目录模型，不改变现有执行路由。
2. 根记录包含稳定 `id`、`target`、`role`、规范化 `path` 和 `displayName`。
3. v1 的 `workspaceRoot` 迁移为唯一 `remote/primary` 根；运行期继续提供
   `workspaceRoot` 兼容字段，且必须与该主根一致，避免形成两个可分叉的项目身份。
4. v2 允许记录 `local/secondary`，但本批次不提供选择入口、执行器或工具访问，因此
   不会因为配置模型升级而扩大本地权限。
5. 对根 ID 重复、多个主根、本地主根、非规范路径、`workspaceRoot` 与远端主根不一致
   等情况失败关闭。
6. 完成配置定向测试和 `npm run check` 后独立提交；工作区主次提示与 turn 级刷新留在
   阶段 2B，Core 防线探针留在阶段 2C。

当前进度：阶段 2A 和 2B 的实现已完成；阶段 2C 已部分实施并保持待补测。全量门禁为
33 个测试文件通过、1 个真实远端条件测试文件跳过，139 项通过、5 项跳过。构建、
Shim 冒烟、Linux x64 当前平台打包、官方 app-server 的专用权限配置激活和活动
VS Code transport 的 `remote_exec(["pwd"])` 回环通过。25 个已知本地客户端请求的
协议诱饵测试及五类 Core 本地审批负测通过；官方 UI 新建/恢复、附件、当前文件和真实
模型专用工具诱饵仍待补测，配置中的本地次级根仍不可访问。

阶段 2A 实机复核发现（2026-07-22）：

- 用户重载后，持久化配置和窗口会话配置均为 v2，且只有
  `/home/unitree/mimiclite-sim2real` 一个 `remote/primary` 根；Bridge 重新进入
  `ready`。
- 远端实际加载的 Executor 仍是旧 `0.2.6` 构建，其 `extension.cjs` SHA-256 与本次
  内嵌候选不一致。原因是 Controller 只校验协议 v4，只要旧命令可用就跳过安装。
- 修复批次 2A.1 曾将 Executor 升级为 `0.2.7` 并在 ping 中同时校验协议号和精确包
  版本。该门禁会把仍具备所需能力的构建判为不兼容，已由 `0.3.2` / Executor `0.2.8`
  的能力集合握手取代。
- 新握手忽略 Executor 包版本与协议号的具体值，只要求当前 Controller 实际需要的
  远端读写、命令和 stdio 能力。缺能力时仍通过现有 Remote SSH transport 安装内嵌包；
  安装状态按候选摘要限次，避免无限重载。

实施：

1. 在通过阶段 1 的官方扩展内置运行时候选上做三组真实实验：远程根写入
   `runtimeWorkspaceRoots`、远程根只作为 Bridge 逻辑主根、继续使用控制目录。分别
   验证新建、恢复和 turn；附件与当前文件保留为真实 UI 验收项。
2. 选取不破坏官方工作区加载的方案；不得用 URI 合成或路径伪装通过项目校验。已选定
   本地控制 `cwd` 加远程逻辑 `runtimeWorkspaceRoots`。
3. 将配置升级为 v2，引入根目录记录：
   `id`、`target: local | remote`、`role: primary | secondary`、规范化路径和显示名。
4. 固定当前 Remote SSH 根为唯一 `primary/remote`，并为 v1 配置提供无损迁移。
5. 在 `thread/start`、`thread/resume` 和每次 `turn/start` 刷新远程目标与
   `remote_exec` 提醒，测试原有指令不会被覆盖。
6. 探查当前插件内置运行时的 permission profile 对本地根的拒绝能力；用
   `PreToolUse` hook 拒绝 Bash、`apply_patch` 和已知本地文件工具，作为第二层防线。
7. 使用本地同名诱饵目录执行负向测试，确认 Core 工具不能读取、写入或执行项目路径。
8. 若仍存在 hook 或 sandbox 绕过路径，记录为阻塞项并评估 Core 修改或独立客户端。

阶段 2B 详细实施顺序：

1. 将 `TurnStartParams` 纳入受控生成协议，并用测试固定
   `runtimeWorkspaceRoots`、`additionalContext` 这两个依赖字段。
2. `thread/start`、`thread/resume` 和 `turn/start` 保留本地控制目录为 `cwd`，把唯一
   `remote/primary.path` 写入 `runtimeWorkspaceRoots`。
3. 在线程新建和恢复时合并完整远程策略；每次 turn 通过
   `additionalContext.codex-remote-bridge` 刷新远程主根、主次身份和
   `remote_exec` 命令路由，不覆盖客户端已有键。
4. 诊断和 `shim.start` 审计同时记录本地控制目录与远程主根的身份；不得记录 transport
   token 或其他凭据。
5. 运行重写和协议定向测试、Shim 集成/冒烟、`npm run check` 和当前平台打包；安装候选
   后在真实 Remote SSH 新建和恢复任务中检查 Codex 日志与 Bridge 审计。
6. 若官方 UI 的附件、当前文件或任务创建仍把本地控制目录显示为项目根，保持候选状态并
   记录 `待补测`，不回退到 URI 合成。

阶段 2C 能力探查结论（2026-07-22）：

1. 当前官方扩展内置 Codex 为 `0.145.0-alpha.27`。生成的 app-server 客户端协议除
   线程请求外，还公开了可直接触达本机的 `thread/shellCommand`、`fs/*`、
   `command/exec*`、`process/*`、`fuzzyFileSearch*` 和后台终端请求；其中
   `thread/shellCommand` 与 `process/spawn` 明确不继承线程 sandbox。
2. 当前运行时接受自定义 named permission profile，并允许线程通过 `permissions`
   选择它。Bridge 可用只读最小运行时加全局拒绝、禁用网络及 `approvalPolicy=never`
   形成 Core 内部的失败关闭约束；必须同时重写线程新建、恢复、设置更新、fork 和 turn，
   防止客户端后续放宽。
3. `PreToolUse` 能覆盖常见 Bash、统一命令执行、`apply_patch`、MCP 和多数本地函数
   工具，但 session flag 注入的 hook 在 `hooks/list` 中是 `untrusted`。自动写入用户
   信任状态会越权，全局跳过 hook 信任又会连带执行用户其他未审核 hook，因此本阶段
   不自动启用。
4. 官方文档明确部分专用工具可以绕过默认 hook 路径。即使未来解决 hook 信任问题，
   hook 也只能作为纵深防御，不能替代权限配置、协议阻断和真实诱饵负测。
5. 当前 Linux 容器中的直接权限探针在进入文件检查前被 `bwrap` 环回网络初始化错误
   阻断，无法据此证明文件拒绝命中。协议接受和线程绑定已经验证；Core 内部读写拒绝
   仍需在兼容的真实 Extension Host 环境用模型驱动诱饵测试确认。

阶段 2C 详细实施顺序：

1. 将官方生成的 `ClientRequest`、线程设置更新和 fork 参数纳入受控协议快照；自动从
   `ClientRequest` 提取上述高风险本地方法集合，协议升级新增同类方法时测试失败关闭。
2. Shim 仅在已配置 Remote Bridge 的 app-server 会话中注入专用 named permission
   profile；普通本地窗口和非 app-server 透传不受影响。
3. 在 `thread/start`、`thread/resume`、`thread/settings/update`、`thread/fork` 和
   `turn/start` 强制专用 profile、`approvalPolicy=never` 与控制目录，移除客户端提供
   的 legacy sandbox 覆盖；远程逻辑主根和原有上下文继续保留。
4. 在 Shim 的客户端请求边界拒绝所有已知高风险本地请求，不向官方 app-server 转发，
   为有 ID 的请求返回稳定 JSON-RPC 错误，并写入不含参数和路径内容的失败审计。
   Core 发起的本地命令、文件和权限审批也在服务端请求边界直接失败关闭，不投影到 UI。
5. 用集成测试发送本地 Shell、文件读取、命令执行、进程启动、模糊搜索和后台终端诱饵，
   断言官方 app-server 收到 0 个危险请求；同时验证普通请求和远程动态工具链不回归。
6. 运行定向测试、受控协议兼容测试、Shim 冒烟、`npm run check` 和当前平台打包；随后
   安装候选并在真实 Remote SSH 窗口检查官方任务、Codex 日志与 Bridge 审计。
7. 若真实模型仍可通过专用 Core 路径触达本地诱饵，SAFE-CORE 保持受阻并转入 Core
   修改或独立客户端评估；不得因此开放双端写入。

阶段 2C 可证伪验收：

- 已知高风险客户端请求全部被 Shim 拒绝，app-server 侧接收数为 0，审计逐项可见。
- 客户端不能通过设置更新、fork、新建、恢复或 turn 放宽专用权限配置。
- 官方 app-server 接受专用 profile，线程新建和恢复不因策略注入失败。
- 真实模型对本地同名诱饵的读取、写入和执行均失败，远程 `remote_exec(["pwd"])` 仍命中
  唯一远程主根；缺少任一真实证据时 SAFE-CORE 只能标为“部分实施/待补测”。
- 不修改 hook 信任状态，不启用全局 hook 信任绕过，不扩大本地次级根访问范围。

验收：

- 诊断和审计明确显示远程主根、本地控制目录及各自角色。已通过自动化与回环审计。
- 新建、恢复和 turn 中远程主根保持一致。app-server 参数链路和候选 Shim 回环已通过；
  官方 UI 新建/恢复待补测。
- 本地控制目录不被展示为项目根。协议层已分离；官方 UI 显示待补测。
- 错误本地项目操作为 0；不能证明时不得进入双端写入。

提交边界：

- 配置 v2 与迁移一个提交。
- 工作区主次语义与提示刷新一个提交。
- Core 防线与负向测试一个提交；若探针失败，只提交证据和阻塞结论。

### 阶段 3：双端只读与本地授权根

目标：在同一任务中显式读取远程主根和本地次级根，不开放写入。

实施：

1. 抽象统一的 `WorkspaceExecutor`，分别实现远端执行器和 Controller 本地授权执行器。
2. 增加本地根选择、持久化、撤销和诊断；配置与日志不得保存凭据或会话 token。
3. 为读取、目录、目录树、搜索和状态请求增加根 ID 与
   `target: local | remote`，禁止按绝对路径格式猜测目标端。
4. 两端统一返回根 ID、目标端、主次角色、规范化路径、大小、时间、哈希、截断和错误。
5. 本地与远端都执行词法、真实路径和符号链接边界检查。
6. 对两端设置文件大小、目录项、树深、搜索结果和并行读取上限。
7. 更新原生 UI 投影，使命令项和审计能区分本地次级与远程主目录。

验收：

- 同一任务可交替读取两端同名文件，结果身份不会混淆。
- 越界、符号链接、父路径和未授权根均被拒绝。
- 默认项目请求仍路由到远程主根，不自动读取本地次级根。
- Remote SSH 模式没有新增 SSH 认证。

提交边界：

- 协议和类型一个提交。
- 本地授权执行器一个提交。
- 双端只读路由和 UI 投影一个提交。

### 阶段 4：取消、幂等与断线确认

目标：有副作用命令在取消和断线后不会静默继续或重复执行。

实施：

1. 将 `turn/interrupt` 关联到该 turn 的活动 Bridge 调用。
2. Remote Executor 协议升级，增加稳定 operation ID、cancel 和 result-status 操作。
3. Controller、transport 和 Remote Executor 为活动操作保存 `AbortController`；取消时
   终止进程组而不是只关闭本地 socket。
4. 为非幂等操作增加 `idempotencyKey` 和带上限的结果账本，区分 running、completed、
   cancelled、failed 和 unknown。
5. socket 重连后先查询 operation 状态；已完成调用返回原结果，未知调用不得自动重放。
6. 明确 VS Code 窗口关闭、Executor 失联、Shim 退出和超时的结果语义及审计字段。

验收：

- 长命令取消后远端进程树消失，取消确认耗时达到发布门禁。
- 相同幂等键不会产生第二次副作用。
- 断线恢复不重放命令，能返回已完成结果或明确 `RESULT_UNKNOWN`。
- 三种关闭方式的遗留进程为 0。

提交边界：

- transport cancel 与进程树终止一个提交。
- 幂等账本和结果查询一个提交。
- 断线恢复与生命周期证据一个提交。

### 阶段 5：双端安全写入

目标：在阶段 2 和阶段 4 门禁通过后开放受控写入。

实施：

1. 增加创建、整文件写入、结构化补丁、创建目录、重命名和删除工具。
2. 修改已有文件必须携带 `expectedHash`；新建必须声明“不存在”前置条件。
3. 通过同目录临时文件、权限继承、刷新和原子替换完成整文件写入。
4. 补丁先在内存中应用并校验基础哈希，再执行原子替换。
5. 写入、覆盖、重命名和删除接入官方审批，审批绑定目标端、根 ID、规范化路径和摘要。
6. 两端使用相同错误码处理冲突、权限、部分失败和结果未知。
7. 审计记录目标端、角色、路径、操作、审批、旧/新哈希、字节数和幂等结果，不记录正文。

验收：

- 远端与本地次级目录分别完成新建、修改、补丁、重命名和删除。
- 并发修改导致冲突拒绝，原文件保持完整。
- 本地与远端诱饵文件证明没有跨端写错。
- 断线、取消和 Executor 失联不会留下半写文件。

提交边界：

- 原子写入原语一个提交。
- 补丁与冲突处理一个提交。
- 重命名/删除、审批和审计一个提交。

### 阶段 6：后台任务

目标：复用阶段 4 的 operation ID 和结果账本管理非交互后台任务。

实施：

1. 增加 background start/status/log/cancel 协议，不复用普通 `remote_exec` 的一次性响应。
2. 为日志设置游标、大小上限和保留时间。
3. 限制后台任务数量、工作目录和环境变量；禁止脱离 Executor 的无主进程。
4. 窗口恢复后只恢复观察，不自动重启任务。

验收：

- 任务状态、增量日志、退出码和取消结果可查询。
- 窗口关闭或 Bridge 停止后的保留策略明确且无未登记进程。
- 重连不会启动第二个同幂等键任务。

### 阶段 7：远程 URI、Diff 和文件跳转

目标：让官方界面中的远程路径可打开、可比较且不会落到本地同名路径。

实施：

1. 定义包含 host、根 ID 和相对路径的 Bridge 资源 URI。
2. 提供只读内容提供器和 Diff 两侧资源映射。
3. 将动态工具投影、修改摘要和错误路径统一为远程资源身份。
4. 验证当前文件、选区、附件、Diff 和跳转在 Remote SSH 窗口中仍指向远端。

验收：

- 点击结果打开当前远程工作区文件。
- Diff 两侧身份明确，不读取本地同名诱饵文件。
- 官方扩展升级后重新执行任务创建与文件上下文链路。

### 阶段 8：P0 收口和发布

1. 在 Linux 与 Windows 分别运行定向测试、`npm run check` 和本平台打包。
2. 建立受控产物收集步骤，再运行双平台包完整性检查；不得依赖 Linux 生成 Windows
   SEA，也不得让后一次本机构建删除已收集的另一平台产物。
3. 清理 `dist/`，只保留当前双平台 Controller、版本化 Executor 和无版本嵌入副本。
4. Windows x64 与 Linux x64 分别执行官方任务、Shim、Remote SSH、MCP、设置恢复和
   生命周期验收。
5. 采集 `docs/upgrade-tracking.md` 的最低样本数、P50、最大值和硬指标。
6. 检查 Codex 日志与 Bridge 审计，确认本地项目操作、额外认证、远端 Codex、敏感信息
   和遗留进程均为 0。
7. 更新兼容矩阵、实施状态和独立候选记录；缺失证据保持 `待补测`。

### 阶段 2D：本地外部 Codex CLI 优先介入

目标：让当前本地 Codex CLI 对话通过 Bridge 持久 MCP 列出、读取并介入官方扩展正在
使用的 Codex 对话，不要求用户切换到另一个 TUI。MCP 底层通过受控网关连接同一
app-server，并按目标 thread 的权限模式提交 turn、追加输入和取消。通用文件写入仍
等待阶段 5，系统 CLI 不参与官方 app-server 的发现、选择、透传或回退。

已完成的能力探查（2026-07-23）：

1. 官方扩展内置 `0.145.0-alpha.27` app-server 可同时接受两个独立 WebSocket 客户端；
   两端都会收到 thread、turn 和 item 通知。
2. 客户端 A 创建 thread 和活动 turn 后，客户端 B 可用相同 thread/turn 标识成功执行
   `thread/resume`、`turn/steer` 和 `turn/interrupt`；`turn/steer` 返回同一活动 turn。
3. 官方 CLI 已提供 stdio MCP 客户端和 `codex --remote ws://...`；当前 CLI 对话适合
   通过持久 MCP 调用控制工具，`--remote` 只作为底层探针和人工诊断入口。
4. `app-server daemon` 依赖独立安装器管理的 Codex，不能由官方扩展内置二进制直接
   托管，因此 Bridge 需监督当前 app-server 生命周期，不能依赖系统 daemon。
5. 外部客户端不能直连未经代理的上游，否则会绕过 Shim 的远程主根改写、Core 本地
   阻断、Codex 权限跟踪和 Remote SSH 工具路由。

首批实施：

1. Shim 监督一个官方扩展内置 app-server WebSocket 上游，并为官方扩展 stdio 客户端
   和每个外部 CLI 分别建立上游连接；所有客户端复用同一 app-server 实例。
2. Bridge 暴露仅监听 loopback 的短期网关，以当前用户状态目录中的 `0600` 能力凭证
   鉴权；凭证不进入命令行、日志、审计、远端环境或仓库。
3. 每个客户端请求都经过既有 `rewriteClientMessage`、Core 本地请求阻断、权限跟踪和
   server request 路由；CLI 发起的 `remote_exec` 继续复用活动 VS Code Remote SSH
   transport，`full-access` 不增加 Bridge 审批。
4. Shim 提供稳定 stdio MCP 服务，至少暴露对话列表、对话读取、介入和取消工具；
   工具动态发现全部活跃 Bridge 会话，不要求当前 CLI 切换自己的 thread。
5. Controller 激活时默认协调 `codex mcp` 注册与稳定启动器，并在插件升级、Shim 内容
   地址变化或窗口重载时自动刷新；显式停用会持久阻止重建，重新启用后恢复。
6. 保存当前 thread 标识和最小连接元数据，使 MCP 能明确定位 VS Code 当前对话；
   对话内容、OpenAI 登录材料和 Remote SSH transport token 均不写入元数据。
7. 依赖官方 app-server 的 `expectedTurnId` 与 turn 状态处理同时提交；Bridge 不另设
   限制 `full-access` 的单写者租约，冲突响应和有序事件原样投影并审计来源连接。

当前进度：第 1-7 项源码和自动化已完成。`npm run check` 为 37 个测试文件通过、1 个
真实远端条件文件跳过，157 项通过、5 项跳过；真实官方 app-server 冒烟已覆盖普通
本地窗口和 Remote SSH 窗口的受鉴权外部连接及 MCP 四工具列表，双客户端集成已覆盖
list/read/new-turn/steer/interrupt、跨客户端 `full-access` 权限继承和 `remote_exec`
无二次审批。`0.3.3` 已在真实普通本地和 Remote SSH 窗口验证当前 CLI 接入、VS Code
UI 投影、审计、远端命令/读取和 CodeGraph；Windows x64、旧 CLI 热切换、官方面板
发起的取消和完整生命周期待补测。

后续写入扩展：

1. CLI 发起的远程文件修改只能调用阶段 5 的 Bridge 写入协议，继续执行目标端、
   `expectedHash`、原子替换、幂等和审计；审批直接继承 thread 的 Codex 权限模式，
   `full-access` 自动放行。禁止另开 SSH 或直接写远端。
2. 审计对话读取、turn 写入、项目写入、审批、取消和断开，记录外部客户端
   实例 ID 与 operation ID，不记录对话正文、文件正文或凭据。

验收：

- CLI 可发现并只读回放当前反代对话，续接后 VS Code 与 CLI 看到一致的有序事件。
- CLI 提交的 turn 和远程文件变更在 VS Code UI 中可见，来源明确，审批与审计完整。
- `full-access` 下 CLI 与 VS Code 都不出现 Bridge 追加的二次审批；其他权限模式的
  允许、询问和拒绝结果与同一 thread 的 Codex 行为一致。
- VS Code 与 CLI 的通知顺序一致；官方 `expectedTurnId` 冲突、断线和结果未知失败关闭。
- 撤销 CLI 权限后，既有连接和新请求都被拒绝，且不会影响 VS Code 主客户端继续工作。
- 本地与远程同名诱饵、双客户端并发、敏感信息扫描及 Linux/Windows 实机通过。
- 重新执行阶段 8 全部 P0 门禁并建立独立候选记录后，才能标记最终完成。

提交边界：

- 共享 app-server 网关、鉴权和能力握手一个提交。
- 当前 CLI 持久 MCP、对话控制工具和自动刷新一个提交。
- 外部 turn/项目写入、审批、幂等和审计一个提交。
- 双平台双客户端实机证据和最终发布记录一个提交。

### 阶段 2E：双向实时同 thread CLI

目标：让本地 Codex CLI 与 VS Code 官方插件同时连接 Bridge 监督的同一 app-server，
恢复同一个 thread。任一端提交输入、接收流式 item、观察工具状态、取消 turn 或读取
历史时，另一端看到同一组有序事件和最终状态。

已有边界：

1. 共享网关已经为每个外部客户端建立独立上游连接，并把完整 JSON-RPC 双向经过同一
   Shim 策略；官方 app-server 不保证跨上游广播，因此 Bridge 必须统一中继无 ID
   通知，不能把多客户端可连接误当成流式通知天然双向。
2. 本机 Codex CLI `0.145.0` 提供 `codex resume <thread> --remote <endpoint>` 和
   `--remote-auth-token-env`。项目不固定 CLI 版本，运行前必须探测这些参数。
3. 已经运行的普通 CLI 会话没有热切换 app-server 的公开接口，不能原地迁移；首次进入
   实时模式必须结束该进程并由托管入口恢复 VS Code thread。
4. MCP 无法订阅后自动把事件注入模型上下文，复制 rollout 也会产生双份历史，因此
   MCP 继续负责发现和控制，实时模式使用官方远程 TUI 协议。

实施：

1. 为 Shim 增加 `attach-cli` 入口，只从活跃且进程存活的 Bridge 描述符选择 host、
   workspace 和 thread；过期、歧义或无线程时失败关闭。
2. 附着入口读取 `0600` 短期令牌并只放入 Codex 子进程环境，argv 仅包含 endpoint、
   thread ID 和环境变量名；Codex 登录材料仍由 CLI 自身管理。
3. Controller 激活时默认维护显式 `codex-vscode` 入口；POSIX 上解析当前系统 `codex`
   的实际符号链接，保存官方绝对入口和原始链接目标，再把无参数普通 `codex` 自动路由
   到活动 VS Code thread。Bridge/Shim 升级后刷新两个入口；显式停用时恢复原始
   `codex` 链接，只删除自身托管的入口和 MCP 注册并持久保留选择。
4. CLI 使用官方 `resume --remote` 直接成为共享 thread 客户端；Remote SSH 请求继续
   经过工作区改写、Core 本地阻断、目标 thread 权限跟踪和远程工具路由，普通本地
   窗口则保留官方原始 `cwd`、权限和审批参数。
5. 增加双向输入、流式 item、工具状态、`turn/steer`、`turn/interrupt`、一端断开、
   网关重启和过期描述符测试；同时覆盖“上游仅回原连接”和“上游全局广播”并验证
   去重，不得只验证请求返回值。
6. 运行 `npm run check`、安全扫描与 Linux 包构造，再由用户分别重载真实普通本地和
   Remote SSH 窗口，在 CLI 与 VS Code 两端各发起一次 turn 和一次取消并核对审计。
7. Windows x64 独立构造和实机结果保持 `待补测`，不得从 Linux 结果推断。

当前进度：第 1-5 项源码与自动化完成。共享服务会在无 Remote SSH 会话配置时以当前
本地 `cwd` 启动官方 app-server，记录 `host=local` 的活动 workspace/thread 描述符，
同时关闭远程请求改写；Remote SSH 分支保持原有控制目录和远程主根策略。长期
`codex-vscode` 入口、POSIX 普通 `codex` 的可恢复接管、令牌只经环境变量传递、双向
事件/取消及一端断开测试均通过自动化。普通入口遇到多个歧义会话时失败关闭；子命令和
没有活动 thread 时仍透传保存的官方 CLI，避免递归。
共享网关现对无 ID 的 thread/turn/item 通知执行跨下游广播和短时来源去重，带 ID 的
响应与服务端请求仍保持原连接路由。真实本地窗口已自动协调 MCP/启动器，并由
`codex-vscode` 恢复同一 thread、显示当前
输入、流式工具事件和历史；CLI 发起的验收 turn 已返回预期标记，官方 UI 同时记录
thread 未读状态变化。CLI 对活动 turn 的真实取消也已在两端投影，附着退出不影响官方
主客户端。普通 `codex` 自动入口也已在安装后重载的真实本地窗口恢复同一 thread，
显示当前输入、回复、工具过程和历史；进程参数、loopback 连接、接入和断开审计均已
核对。修复后实机由外部连接启动 turn，CLI 收到逐段 delta 和最终标记；审计确认 10 条
通知写入 VS Code 主 stdio 客户端，官方 Codex 日志确认收到并绑定该 turn。扩展安装
状态变化也会自动触发协调，Shim 内容迁移后自动重载。`0.3.2` 再次实机验证该迁移：
首次旧路径失败后 Controller 自动刷新 Shim 并二次重载；普通 `codex` 随后在同一
thread 完成 Shell、CodeGraph MCP 和最终回复，审计确认向 VS Code 转发 22 条通知，
没有版本不兼容门禁。`0.3.3` 又在真实 Remote SSH 窗口补齐外部 CLI 链路：未物化
thread 自动回退为新建同步 thread，TUI 在 YOLO 模式连续完成两轮，逐项打印远端
`pwd`、README 读取、CodeGraph 调用和最终回复；审计确认 `full-access` 自动放行、
没有二次审批，并向 VS Code 主客户端转发 141 条通知。官方日志和 thread 读取确认
同一 thread 在 UI 侧活动且有 2 个完成 turn。当前剩余官方 UI 发起方向的 Remote SSH
取消、完整生命周期和 Windows x64 待补测。

验收：

- CLI 输入和流式输出实时出现在 VS Code 的同一 thread，VS Code 输入和流式输出也实时
  出现在附着 CLI；两端 thread ID、turn ID、顺序和最终历史一致。
- 任一端取消同一 turn 后，两端均收到同一 interrupted/completed 结果，活动远端命令
  按生命周期规则终止；另一客户端保持可用。
- `full-access` 继承目标 thread 且没有 Bridge 二次审批；其他模式不被附着 CLI 升权。
- 令牌不出现在进程参数、MCP 配置、日志、审计、远端环境或仓库；过期描述符无法连接。
- 插件升级后稳定入口自动指向新 Shim；既有连接断开后可重新附着，不产生重复 thread。

## 6. 当前阻塞与待用户配合

- 外部 CLI 发起的 Remote SSH 新任务、审批继承和多轮工具链已完成；官方面板发起的
  新任务、取消和断线仍需在真实窗口单独执行。Controller 自身升级引起的本地 Shim
  迁移已自动重载。
- Windows x64 实机链路当前不可由本次 Linux 环境替代。
- Windows SEA Shim 与 Controller VSIX 不能由当前 Linux 构建生成；完整 `dist/` 需由
  Windows、Linux 两端产物收集后再验。
- `runtimeWorkspaceRoots` 的 app-server 参数链路已经通过无副作用探针；官方 UI 的新建、
  恢复、附件和当前文件显示仍需在安装候选后实测。
- 专用 permission profile 和 25 个客户端请求阻断已经实施，但真实模型是否仍能通过
  app-server 内部专用工具触达本地诱饵尚未证明；官方文档明确 hook 不是所有专用工具
  的完整强制边界。Remote SSH 外部 CLI 已复核，但真实本地诱饵仍待单独验证。

在这些证据补齐前，可以继续完成隔离的协议、类型和单元测试工作，但不得把相应功能或
兼容集合声明为已经支持。
