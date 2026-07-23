# 当前能力边界与实施计划

更新日期：2026-07-22

本文重新汇总所有待实现、待验证和待补测事项，并基于当前源码、协议、测试、审计日志
和活动 Remote SSH 窗口划定能力边界。后续新增功能必须按本文顺序实施；每个阶段都要
完成定向自测、任务文档同步和独立中文意图提交。

本文是实施基线，不改变 `docs/compatibility.md` 的支持声明。没有完成官方任务创建、
真实远程操作或双平台实机验证的项目继续标为 `待补测`。

## 1. 本次复核快照

### 1.1 当前组件

| 组件 | 2026-07-22 实测值 | 当前结论 |
| --- | --- | --- |
| 本地平台 | Linux x64 | 可执行 Linux Controller 自动化与打包 |
| VS Code | `1.130.0` | 相对发布基线已变化，真实任务链路需重跑 |
| 官方 Codex 扩展 | `openai.chatgpt@26.715.61943` | 已启动 Shim 并恢复已有会话；新任务创建待补测 |
| 官方扩展内置 Codex | `0.145.0-alpha.27` | 当前唯一 app-server 来源；内置协议门禁已同步 |
| 系统 Codex CLI/app-server | 任意或未安装 | 不属于兼容集合，不参与发现、选择、透传或回退 |
| Bridge Controller | `0.2.7` | 重构候选已安装；当前窗口重载待补测 |
| Remote Executor | `0.2.5` / 协议 v3 | 当前远端工作区执行协议 |
| Remote SSH | `0.124.0` | 当前存在活动的已认证 Remote SSH transport |

仓库不固定官方扩展版本；当前生成协议记录的来源扩展为 `26.715.61943`，内置协议
基线为 `codexAppServerVersion=0.145.0-alpha.27`，协议位于
`protocol/0.145.0-alpha.27/`。Controller 只接受通过官方扩展 API 定位的内置二进制；
Shim 从受限运行时指针读取同一二进制并再次执行协议校验。缺失或不匹配时失败关闭，
不会探测系统 CLI。

### 1.2 当前自动化证据

2026-07-22 在 Linux x64 本机执行 `npm run check`：

- TypeScript 类型检查通过。
- 30 个测试文件通过，1 个真实远端条件测试文件跳过。
- 112 项测试通过，5 项真实远端条件测试跳过，0 项失败。
- Controller、Shim 和 Remote Executor 构建通过。
- 插件内置 `0.145.0-alpha.27` 的本地透传、远程窗口启动和线程创建 Shim 冒烟通过；
  缺少受控运行时指针时，即使 PATH 存在系统 CLI 也失败关闭。
- Linux x64 Controller VSIX 和匹配的 Remote Executor VSIX 打包通过。

这些结果证明当前源码自动化基线与 Linux 包构造可用，但不证明官方扩展新任务、远程
命令取消、断线恢复、双端读写或 Linux Controller 的完整 Remote SSH 用户链路。

随后补跑 `npm run package:all` 时，Linux 主机因没有 Windows 构建生成的
`dist/codex-bridge-shim.exe` 而失败。当前打包脚本不能在单一 Linux 工作区独立重建
双平台 Controller；Windows 包必须由 Windows 构建产出并进入受控收集流程。

### 1.3 当前真实窗口证据

活动 VS Code Remote SSH 窗口已连接 `g1_1`，工作区为
`/home/unitree/mimiclite-sim2real`。当前日志证明：

- Bridge 复用现有 Remote SSH transport 并进入 `ready`。
- 重载前的 `openai.chatgpt@26.715.61943` 窗口曾启动当前 Shim 和本地
  `0.144.5` app-server。
- 已有会话能够恢复并开始新 turn。
- Remote Executor 和远端 CodeGraph stdio MCP 进程位于远端 Extension Host。

本次没有由用户手动新建官方任务，也没有在当前窗口执行固定读、搜、Git、`pwd`、审批、
取消和断线探针，因此这些项目不能从“窗口已连接”推定为通过。历史审计中存在成功的
`remote_exec` 记录，但不能替代当前兼容集合的重新验收。

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
- 协议生成、内置协议门禁、缺少运行时指针的失败关闭、真实 app-server 冒烟和 Linux
  候选打包已通过。

官方扩展新任务、MCP、固定远端探针和真实 Remote SSH 链路尚未重跑，因此当前只能
视为候选升级。

## 2. 重新汇总的任务清单

| ID | 任务 | 当前状态 | 已有能力 | 主要缺口 |
| --- | --- | --- | --- | --- |
| RUNTIME-OFFICIAL | 仅依赖官方扩展内置 Codex | 已实施 | Controller 只从官方扩展 API 定位内置二进制，旧路径设置已删除 | 真实官方任务待验证 |
| RUNTIME-PASSTHROUGH | 本地窗口透传使用插件内置 Codex | 已实施 | Shim 使用受限运行时指针并在缺失时失败关闭 | 真实普通本地窗口待验证 |
| COMP-BUNDLED | 为插件内置 app-server 生成协议 | 已实施 | 不固定插件版本；内置 Codex 协议门禁、快照和自动化已同步 | 插件升级链路和真实界面待验证 |
| COMP-145 | 适配外部 Codex `0.145.0` | 已完成后被取代 | CLI、协议、版本门禁、测试、Shim 冒烟和 Linux 候选包已完成 | 不再作为最终运行时或发布支持目标 |
| COMP-OFFICIAL | 验证 `openai.chatgpt@26.715.61943` | 待验证 | Shim 启动、已有会话恢复、Bridge `ready` | 新任务创建、审批、继续会话和本地窗口透传证据不足 |
| ROUTE-EXEC | 强化 Remote SSH 下的 `remote_exec` 路由 | 部分实现 | 新建/恢复线程注入提醒，动态工具描述明确 | turn 级提醒未刷新，模型仍可能选择 Core 本地工具 |
| ROOT-PRIMARY | 远程工作区成为主工作目录 | 待实施 | 远程命令默认 `cwd` 是远程根目录 | Codex 线程仍以本地控制目录为 `cwd` 和 runtime root |
| ROOT-SECONDARY | 定义本地次级授权目录 | 待实施 | 配置可持久化单个远程根目录 | 没有本地授权根、主次角色、选择和撤销协议 |
| DUAL-READ | 双端目录读取、树、搜索和状态 | 待实施 | 远端只读工具完整；Remote Executor 有路径约束 | 工具没有 `target`；Controller 没有本地授权目录执行器 |
| DUAL-WRITE | 双端写入、补丁、重命名和删除 | 待实施 | 读取结果已返回远端 SHA-256 | 没有写工具、`expectedHash`、原子替换或统一错误语义 |
| LIFE-CANCEL | 运行中取消 | 待实施 | 执行器底层接受 `AbortSignal`，超时能终止子进程 | app-server `turn/interrupt` 没有传到活动远端请求 |
| LIFE-IDEMP | 幂等和断线结果确认 | 待实施 | 有 `callId`、`requestId`、`connectionId` 和 `RESULT_UNKNOWN` | 没有幂等账本、结果查询、重连确认或去重 |
| LIFE-BACKGROUND | 后台任务 | 待实施 | MCP stdio 有长生命周期会话管理 | 普通命令没有 start/status/log/cancel 协议 |
| SAFE-CORE | Core 本地 Shell/文件工具硬阻断 | 待实施 | 本地只读 sandbox、空控制目录、提示约束 | 提示不是强制边界，Shim 不拦截 Core 内置工具 |
| UX-REMOTE | 远程 URI、Diff 和文件跳转 | 待实施 | Bridge 工具可投影为原生 command item | 没有可打开的远程资源身份和 Diff 提供器 |
| PACK-DUAL | 双平台产物构建与收集 | 待实施 | 两个平台分别有原生 Shim 构建逻辑 | Linux 无法生成 Windows SEA，`package:all` 依赖预存 `.exe` |
| VERIFY-P0 | 完整 P0 验收 | 待补测 | 历史 Windows 到 Ubuntu 主链路有部分证据 | 当前兼容集合、取消、写入、安全失败和诱饵文件未闭环 |
| VERIFY-LIFECYCLE | 设置恢复和进程清理 | 待补测 | 逻辑测试覆盖设置恢复；停止时会关闭部分资源 | 三种关闭方式、遗留进程和断线行为缺少实机证据 |
| VERIFY-METRICS | 量化指标 | 待补测 | 已有单样本和门禁模板 | 启动、任务、固定探针和 MCP 未达到最低样本数 |

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
- 当前包不钉住官方扩展版本；内置 Codex 与生成协议不匹配时会被拒绝。
- 官方扩展版本变化会改变项目校验和任务创建行为，协议测试不能替代官方 UI 验收。

### 3.2 Codex 提醒和工具路由

已有：

- `thread/start` 注入 `remote_*` 工具和远程执行策略。
- `thread/resume` 重新注入远程策略。
- 策略明确要求项目命令使用 `remote_exec`，禁止回退到本地 Shell 和文件系统。
- 未配置 Bridge 时动态远程工具调用会失败关闭。

边界：

- `turn/start` 只重写本地 sandbox 和控制目录，不重复注入开发者提醒。
- 提醒只能影响模型选择，不能阻止 Core 内置本地 Shell 或文件工具。
- Shim 只接管 `item/tool/call` 中的 Bridge 动态工具；Core 内置工具不经过
  `DynamicToolRouter`。

### 3.3 工作目录和主次角色

已有：

- `BridgeConfig.workspaceRoot` 是唯一的规范化远程 POSIX 根目录。
- `remote_exec.cwd` 是远程工作区相对路径，缺省时由执行器落到远程根目录。
- 远端文件、搜索、Git 和命令都在规范化远程根目录内执行。

边界：

- 本地 app-server 进程必须在本机存在的控制目录中启动。
- 当前 `thread/start`、`thread/resume` 和 `turn/start` 都把 `cwd` 与
  `runtimeWorkspaceRoots` 改成该本地控制目录。
- 远程根目录目前只存在于 Bridge 配置、提示和动态工具中，不是 Codex 线程的逻辑主根。
- 配置版本仍为 v1，`localExecution` 固定为 `deny`，没有本地授权根或
  `primary | secondary` 角色。

实现“远程主工作目录”时必须区分：

1. **本地进程目录**：本地 app-server 可启动的空控制目录。
2. **逻辑主工作目录**：当前 Remote SSH 工作区根目录，是项目工具的默认目标。
3. **次级工作目录**：用户显式授权的本地目录，只能通过带目标端的 Bridge 工具访问。

不能把本机不存在的远程 POSIX 路径直接当作 app-server 进程 `cwd`，也不能改写或伪造
VS Code 工作区 URI。`0.145.0` 的 `runtimeWorkspaceRoots` 是否能表达远程逻辑主根，
必须先通过官方扩展新建、恢复和 turn 级实验确认。

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
- thread/turn sandbox 被固定为本地只读。
- 开发者指令要求项目操作只使用远程工具。

边界：

- 只读 sandbox 仍可能允许读取本地绝对路径；它主要阻止写入，不等于项目隔离。
- app-server 内置 Shell/文件工具不经过 Shim 的动态工具路由，无法在现有代理层硬拒绝。
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

### 阶段 2：远程主工作目录、路由刷新与 Core 防线探针

目标：建立主次目录语义，并在开放本地次级目录前证明项目操作默认只走远端。

实施：

1. 在通过阶段 1 的官方扩展内置运行时候选上做三组真实实验：远程根写入
   `runtimeWorkspaceRoots`、远程根只作为 Bridge 逻辑主根、继续使用控制目录。分别
   验证新建、恢复、turn、附件和当前文件。
2. 选取不破坏官方工作区加载的方案；不得用 URI 合成或路径伪装通过项目校验。
3. 将配置升级为 v2，引入根目录记录：
   `id`、`target: local | remote`、`role: primary | secondary`、规范化路径和显示名。
4. 固定当前 Remote SSH 根为唯一 `primary/remote`，并为 v1 配置提供无损迁移。
5. 在 `thread/start`、`thread/resume` 和每次 `turn/start` 刷新远程目标与
   `remote_exec` 提醒，测试原有指令不会被覆盖。
6. 探查当前插件内置运行时的 permission profile 对本地根的拒绝能力；用
   `PreToolUse` hook 拒绝 Bash、`apply_patch` 和已知本地文件工具，作为第二层防线。
7. 使用本地同名诱饵目录执行负向测试，确认 Core 工具不能读取、写入或执行项目路径。
8. 若仍存在 hook 或 sandbox 绕过路径，记录为阻塞项并评估 Core 修改或独立客户端。

验收：

- 诊断和审计明确显示远程主根、本地控制目录及各自角色。
- 新建、恢复和 turn 中远程主根保持一致。
- 本地控制目录不被展示为项目根。
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

## 6. 当前阻塞与待用户配合

- 官方新任务创建、窗口重载、审批、取消和断线操作必须由用户在 Remote SSH 窗口执行。
- Windows x64 实机链路当前不可由本次 Linux 环境替代。
- Windows SEA Shim 与 Controller VSIX 不能由当前 Linux 构建生成；完整 `dist/` 需由
  Windows、Linux 两端产物收集后再验。
- `runtimeWorkspaceRoots` 是否可安全承载远程逻辑主根需要真实官方扩展实验。
- Core 本地工具是否能被 permission profile 与 hook 组合完全阻断尚未证明；官方文档
  明确 hook 不是所有专用工具的完整强制边界。

在这些证据补齐前，可以继续完成隔离的协议、类型和单元测试工作，但不得把相应功能或
兼容集合声明为已经支持。
