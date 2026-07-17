# Codex VS Code 远程开发桥接需求文档

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 可行性验证详细需求基线 |
| 版本 | 0.2 |
| 日期 | 2026-07-16 |
| 目标仓库 | `/home/zkbot/work/train/MimicLite` |
| 本地主机 | 可联网 Ubuntu，运行 VS Code、Codex 和网络请求 |
| 远程主机 | 离线 Ubuntu，保存代码并执行开发任务 |

本文档定义一个 VS Code 桥接扩展的需求。该扩展应让用户在本地 Ubuntu 上保留 VS Code 和官方 Codex 的使用习惯，同时让文件、命令、Git、测试和 GPU 任务实际运行在另一台无法访问公网的远程 Ubuntu 主机上。

## 2. 背景与问题

当前 VS Code Remote SSH 会根据扩展类型，将需要工作区能力的扩展运行在远程扩展宿主中。官方 Codex 扩展因此倾向于在远程 Ubuntu 上启动 Codex 后端，要求远端安装 Codex，并可能要求远端能够访问 OpenAI 服务。

目标环境存在以下约束：

- 远程 Ubuntu 是实际开发环境，包含代码、依赖、数据、测试环境和 GPU。
- 远程 Ubuntu 无法访问公网。
- 远程 Ubuntu 不应安装或运行 Codex CLI、Codex app-server，也不应保存 ChatGPT 凭据。
- 本地 Ubuntu 可以访问公网，并已安装 VS Code 和官方 Codex 扩展。
- 用户希望使用 ChatGPT 套餐内的 Codex 额度，而不是单独配置 OpenAI API Key。
- 用户希望继续使用 VS Code Remote SSH 的编辑、导航、终端和调试习惯。

因此，需要在本地 Codex 与远程 Ubuntu 工作区之间增加一个可审计、可控且默认安全失败的桥接层。

## 3. 目标

### 3.1 核心目标

1. Codex 的登录、会话、模型请求和额度消耗发生在本地 Ubuntu。
2. 项目文件的读取、搜索、修改和补丁应用发生在远程 Ubuntu。
3. Shell、Git、测试、训练、调试和 GPU 命令发生在远程 Ubuntu。
4. 远程 Ubuntu 不安装、不启动 Codex，也不需要访问公网。
5. 用户在同一个 VS Code 窗口内完成对话、审查变更和远程开发。
6. 桥接不可用时必须停止操作，不得静默回退到本地 Ubuntu 执行。

### 3.2 成功标准

可行性验证通过必须同时满足：

- 用户使用官方 Codex 扩展界面发起任务。
- ChatGPT 登录和 OpenAI 网络流量仅出现在本地 Ubuntu。
- Codex 能读取并修改 `/home/zkbot/work/train/MimicLite` 中的文件。
- Codex 能在远程 Ubuntu 上执行 `pwd`、`git status` 和仓库测试命令。
- 修改结果能在 VS Code 中正常查看和审查。
- 远程 Ubuntu 上不存在 Codex 进程，且不要求安装 Codex。
- SSH 断开后，任何操作均明确失败，不在本地 Ubuntu 上继续执行。

### 3.3 不可破坏约束

以下约束优先级高于兼容性、性能和使用便利性。任一约束无法满足时，可行性验证应判定为失败：

| 编号 | 约束 |
| --- | --- |
| INV-001 | 远程 Ubuntu 不存在 Codex CLI、Codex app-server 或模型运行时。 |
| INV-002 | ChatGPT/Codex 凭据永不离开本地 Ubuntu。 |
| INV-003 | OpenAI 请求永不从远程 Ubuntu 发出。 |
| INV-004 | 项目 Shell、Git、测试和 GPU 命令永不在本地 Ubuntu 执行。 |
| INV-005 | 项目文件写入永不落到本地同名目录或本地缓存副本。 |
| INV-006 | 无法确定执行位置时拒绝操作，不进行推测或自动回退。 |
| INV-007 | 不修改官方 Codex 扩展的安装目录、打包产物或签名信息。 |

## 4. 非目标

首个版本不负责：

- 替代 VS Code Remote SSH。
- 实现新的模型服务或绕过 ChatGPT/Codex 权限控制。
- 在远程 Ubuntu 上转发公网流量或提供通用代理。
- 支持 Codex Cloud、云端工作树或 GitHub 托管任务。
- 支持多人共享同一 Codex 会话。
- 自动安装训练依赖、数据集或 GPU 驱动。
- 修改或重新分发官方 Codex 扩展的闭源代码。
- 通过修改官方扩展安装目录实现功能。

## 5. 术语

| 术语 | 定义 |
| --- | --- |
| 本地端 | 运行 Ubuntu、VS Code、ChatGPT 登录和 Codex 后端的可联网机器 |
| 远程端 | 通过 SSH 连接的 Ubuntu 开发机器 |
| 官方扩展 | 扩展标识为 `openai.chatgpt` 的 Codex VS Code 扩展 |
| Bridge 扩展 | 本项目拟实现的 VS Code 扩展 |
| CLI Shim | 兼容官方扩展所需 Codex CLI/app-server 启动方式的本地代理程序 |
| Remote Executor | 通过 SSH 在远程 Ubuntu 上执行文件和命令操作的组件 |
| 工作区根目录 | 本次会话允许访问的远程目录，例如 `/home/zkbot/work/train/MimicLite` |
| 本地控制目录 | 本地 app-server 使用的空目录，不包含项目文件，也不允许项目命令在其中执行 |
| 远程路径标识 | 由 `hostId`、`workspaceRoot` 和相对路径组成的唯一文件标识 |

### 5.1 参与组件

| 组件 | 运行位置 | 职责 | 是否允许联网 |
| --- | --- | --- | --- |
| VS Code 桌面端 | 本地 Ubuntu | 编辑器窗口、Remote SSH UI、Diff 和命令面板 | 是 |
| 官方 Codex 扩展 | 本地扩展宿主 | 提供官方 Codex 对话与审批界面 | 是 |
| Bridge 扩展 | 本地扩展宿主 | 配置、状态、路径映射、策略和生命周期管理 | 是 |
| CLI Shim | 本地 Ubuntu | 兼容 Codex CLI 启动参数，代理 app-server JSON-RPC | 是 |
| Codex app-server | 本地 Ubuntu | ChatGPT 登录、会话、模型调用和工具编排 | 是 |
| Remote Executor | 本地 Ubuntu | 将结构化文件和命令请求转换为 SSH/SFTP 操作 | 仅访问远程 SSH |
| VS Code Server | 远程 Ubuntu | 提供 Remote SSH 工作区能力 | 否 |
| 项目工具链 | 远程 Ubuntu | Git、测试、训练、调试和 GPU 任务 | 否 |
| 可选远程辅助进程 | 远程 Ubuntu | 无状态地执行受限文件或进程操作 | 否 |

### 5.2 进程放置判定

系统必须能够在诊断信息中证明每个关键进程的位置：

- 本地允许：`code`、官方 Codex 扩展宿主、CLI Shim、`codex app-server`、`ssh`。
- 远端允许：`vscode-server`、项目 Shell、Git、测试、训练和可选辅助进程。
- 远端禁止：`codex`、`codex app-server`、保存或刷新 ChatGPT Token 的进程。
- 本地禁止：以项目工作区为当前目录运行的 Shell、Git、测试和训练进程。

## 6. 总体约束

### 6.1 必须满足

- 官方 Codex 扩展和 Codex 后端运行在本地 Ubuntu。
- 远程 Ubuntu 仅需已有的 OpenSSH、Shell 和项目自身工具链。
- 所有 ChatGPT 凭据、访问令牌和会话状态保存在本地 Ubuntu。
- 所有操作限制在用户明确选择的远程工作区根目录内。
- 使用 SSH 主机密钥校验，不得默认关闭 `StrictHostKeyChecking`。
- 不得把 SSH 私钥复制到扩展目录、工作区或远程 Ubuntu。
- 不得向远程 Ubuntu 写入 Codex 登录凭据。
- 不得在连接失败时回退到本地文件系统或本地 Shell。

### 6.2 允许使用

- VS Code 官方扩展 API。
- VS Code Remote SSH 已建立的工作区信息。
- 本地 Ubuntu 的 OpenSSH 客户端。
- Codex 开源 CLI 和 app-server。
- 官方扩展提供的 `chatgpt.cliExecutable` 开发设置。
- Codex app-server 的 JSON-RPC、MCP 或动态工具接口。
- 无需公网的临时远程辅助进程，但它不得包含 Codex、模型逻辑或用户凭据。

### 6.3 网络与信任边界

| 发起方 | 目标 | 协议 | 默认策略 |
| --- | --- | --- | --- |
| 本地 Codex | OpenAI/ChatGPT | HTTPS/WSS | 允许 |
| 本地 Remote Executor | 远程 Ubuntu | SSH/SFTP | 允许 |
| 本地 VS Code | 远程 Ubuntu | VS Code Remote SSH | 允许 |
| 远程 Ubuntu | OpenAI/ChatGPT | 任意 | 禁止 |
| 远程 Ubuntu | 公网 | 任意 | 保持现有离线策略 |
| 远程 Ubuntu | 本地 Ubuntu | 新建反向连接 | MVP 禁止 |

MVP 不依赖 SSH 反向隧道。所有连接均由本地 Ubuntu 主动发起，远程端不需要发现或访问本地端地址。

### 6.4 数据边界

- 用户明确提交给 Codex 的提示、选中内容和项目上下文可以由本地 Codex 发送给 OpenAI。
- 远程文件内容只能按任务需要读取，不得默认索引或上传整个仓库。
- SSH 配置、主机名和远程路径可以进入本地审计日志，但不得自动发送给模型，除非完成任务确有需要。
- 私钥、Token、环境变量中的密钥、`.env` 内容和系统凭据不得写入日志或工具结果。
- 二进制文件默认只返回元数据；只有用户任务明确需要时才读取内容。

### 6.5 配置所有权

- Bridge 只管理自身命名空间下的设置。
- 如需修改 `chatgpt.cliExecutable` 或 `remote.extensionKind`，必须先保存原值。
- 停止、禁用或卸载 Bridge 时，应提供恢复原值的命令。
- Bridge 不得自动覆盖用户的全局 Codex `config.toml`；确需写入时必须展示差异并获得确认。

## 7. 用户流程

### 7.1 首次配置

1. 用户在本地 Ubuntu 安装官方 Codex 扩展和 Bridge 扩展。
2. 用户使用 VS Code Remote SSH 连接远程 Ubuntu。
3. Bridge 扩展检测 SSH 主机、远程工作区根目录和本地 Codex 状态。
4. 当自动初始化开启且窗口只有一个远程根目录时，用户打开该目录即视为选择本次
   允许访问的范围；Bridge 不再弹出重复确认。
5. Bridge 扩展保存原设置后自动配置本地 Codex 后端入口；首次需要时自动重载一次。
6. 用户在本地 Ubuntu 完成 ChatGPT 登录。
7. Bridge 显示“本地 Codex / 远程执行”已就绪。

### 7.2 日常使用

1. 用户打开远程 Ubuntu 工作区。
2. 用户在官方 Codex 面板中输入任务。
3. Codex 在本地 Ubuntu 上完成模型推理和会话管理。
4. 文件和命令工具调用由 Bridge 路由到远程 Ubuntu。
5. 用户在官方 Codex 面板中审批命令或文件修改。
6. 变更写入远程 Ubuntu，并在当前 VS Code Remote SSH 窗口中显示。

### 7.3 断线恢复

1. SSH 断开后，Bridge 立即将状态切换为“不可用”。
2. 正在运行的操作返回明确的连接错误。
3. Bridge 不重放未确认的写操作。
4. SSH 恢复后，用户确认远端工作区状态，再继续会话。

### 7.4 状态机

Bridge 必须使用显式状态机，状态变化写入本地输出通道：

| 状态 | 含义 | 允许的操作 |
| --- | --- | --- |
| `disabled` | Bridge 未启用 | 仅配置 |
| `configuring` | 正在解析主机、路径和 Codex 版本 | 仅取消 |
| `connecting` | 正在建立 SSH 和 app-server 会话 | 仅取消 |
| `ready` | 本地 Codex和远程执行均可用 | 全部已授权操作 |
| `busy` | 存在活动工具调用 | 新读操作；写和命令按并发策略排队 |
| `degraded` | 只读能力可用，写入或命令能力异常 | 仅远程只读操作 |
| `disconnected` | SSH 或 app-server 已断开 | 禁止全部项目工具调用 |
| `incompatible` | 官方扩展、Shim 或 app-server 协议不兼容 | 仅诊断和恢复设置 |

任何未识别状态按 `disconnected` 处理。状态不得仅依赖 UI 标记，执行层必须再次校验连接代次和远程身份。

### 7.5 VS Code 命令

Bridge 至少提供以下命令：

- `Codex Bridge: Configure Current Remote`
- `Codex Bridge: Start`
- `Codex Bridge: Stop`
- `Codex Bridge: Run Diagnostics`
- `Codex Bridge: Show Audit Log`
- `Codex Bridge: Restore Official Codex Settings`

状态栏应同时显示远程主机别名和状态，例如 `Codex: local -> training-gpu`。不得只显示“已连接”而不显示执行目标。

## 8. 功能需求

优先级定义：

- `P0`：可行性验证和首个可用版本必须具备。
- `P1`：正式使用前应具备。
- `P2`：后续增强。

### 8.1 连接与环境

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| CONN-001 | P0 | 自动识别当前 VS Code Remote SSH 主机和远程工作区根目录。 |
| CONN-002 | P0 | 支持从用户的 OpenSSH 配置读取主机别名、用户名、端口和密钥设置。 |
| CONN-003 | P0 | 连接前验证 SSH 主机密钥，不允许默认忽略校验。 |
| CONN-004 | P0 | 明确展示本地 Codex 状态、SSH 状态、远程主机和远程工作区。 |
| CONN-005 | P0 | SSH 断开时立即停止新工具调用并取消或标记正在执行的调用。 |
| CONN-006 | P1 | 支持连接恢复和会话继续，不重复执行已完成的非幂等命令。 |
| CONN-007 | P2 | 支持多个远程主机和多根工作区。 |

### 8.2 Codex 与认证

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| AUTH-001 | P0 | 使用本地 Ubuntu 的 ChatGPT 登录状态和套餐内 Codex 额度。 |
| AUTH-002 | P0 | 不要求用户提供 OpenAI API Key。 |
| AUTH-003 | P0 | OpenAI 请求必须从本地 Ubuntu 发出。 |
| AUTH-004 | P0 | ChatGPT 凭据、访问令牌和刷新令牌不得传输到远程 Ubuntu。 |
| AUTH-005 | P1 | 支持官方 Codex 会话的创建、继续、停止和历史恢复。 |
| AUTH-006 | P1 | 能检测本地 Codex 与官方扩展的协议版本不兼容，并给出明确错误。 |

### 8.3 远程文件系统

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| FILE-001 | P0 | 支持读取远程文本文件和二进制文件元数据。 |
| FILE-002 | P0 | 支持列出目录、按名称查找文件和按内容搜索文本。 |
| FILE-003 | P0 | 支持创建、修改、重命名和删除工作区内文件。 |
| FILE-004 | P0 | 支持远程应用结构化补丁，并返回每个文件的执行结果。 |
| FILE-005 | P0 | 写入前验证文件未被其他进程修改，避免覆盖并发变更。 |
| FILE-006 | P0 | 所有路径在执行前进行规范化，并限制在工作区根目录内。 |
| FILE-007 | P0 | 默认禁止通过符号链接逃逸到工作区根目录之外。 |
| FILE-008 | P1 | 支持原子写入、文件权限保持和换行格式保持。 |
| FILE-009 | P1 | 将远程变更映射到 VS Code Diff 和文件跳转。 |
| FILE-010 | P2 | 支持大文件分块传输和可配置大小限制。 |

### 8.4 远程命令

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| EXEC-001 | P0 | Shell 命令必须在远程 Ubuntu 的工作区目录中执行。 |
| EXEC-002 | P0 | 返回标准输出、标准错误、退出码和执行时长。 |
| EXEC-003 | P0 | 支持流式输出，用户能看到长时间运行命令的进度。 |
| EXEC-004 | P0 | 支持取消运行中的远程命令。 |
| EXEC-005 | P0 | 支持 Git、测试、训练脚本和 GPU 查询命令。 |
| EXEC-006 | P0 | Bridge 不可用时不得在本地 Ubuntu 上执行原命令。 |
| EXEC-007 | P1 | 支持 PTY、交互式命令和后台进程。 |
| EXEC-008 | P1 | 支持超时、输出上限和进程树终止。 |
| EXEC-009 | P1 | 命令审批界面必须展示远程主机、工作目录和完整命令。 |
| EXEC-010 | P2 | 支持端口转发和远程服务预览。 |

### 8.5 编辑器上下文

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| CTX-001 | P0 | Codex 能获得当前远程工作区根目录。 |
| CTX-002 | P0 | Codex 能引用当前打开文件、选中内容和光标位置。 |
| CTX-003 | P1 | Codex 返回的远程文件链接能在当前 VS Code 窗口中打开。 |
| CTX-004 | P1 | 诊断、Diff 和修改摘要中的路径统一显示为远程路径。 |
| CTX-005 | P1 | 不向模型发送与当前任务无关的远程文件内容。 |

### 8.6 状态与日志

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| OBS-001 | P0 | 状态栏明确显示 `Local Codex / Remote Ubuntu` 或错误状态。 |
| OBS-002 | P0 | 提供独立输出通道，记录连接、路由、耗时和错误。 |
| OBS-003 | P0 | 日志不得包含 ChatGPT Token、SSH 私钥或完整敏感文件内容。 |
| OBS-004 | P1 | 每次工具调用记录本地/远程执行位置，便于证明没有错误回退。 |
| OBS-005 | P1 | 提供诊断命令，输出版本、主机、路径映射和连接检查结果。 |

### 8.7 工具调用契约

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| TOOL-001 | P0 | 每次工具调用包含唯一 `requestId`、连接代次 `connectionId` 和目标 `hostId`。 |
| TOOL-002 | P0 | 文件工具使用工作区相对路径；绝对路径输入必须先验证属于远程根目录。 |
| TOOL-003 | P0 | 命令工具必须显式携带远程 `cwd`，不得依赖本地进程当前目录。 |
| TOOL-004 | P0 | 工具结果必须返回实际执行主机、实际工作目录、成功状态和结构化错误。 |
| TOOL-005 | P0 | 写入和补丁工具必须支持 `expectedHash`，检测并发修改。 |
| TOOL-006 | P0 | 非幂等调用必须携带 `idempotencyKey`，同一连接代次内不得重复执行。 |
| TOOL-007 | P1 | 输出达到上限时返回 `truncated=true` 和继续读取所需的游标。 |
| TOOL-008 | P1 | 所有工具参数在执行前通过 JSON Schema 校验。 |

统一结果结构应至少表达：

```json
{
  "ok": true,
  "requestId": "req_123",
  "connectionId": "conn_456",
  "hostId": "training-gpu",
  "remoteCwd": "/home/zkbot/work/train/MimicLite",
  "data": {},
  "truncated": false,
  "error": null
}
```

统一错误结构应至少包含 `code`、`message`、`retryable` 和 `details`。错误消息不得暗示已执行实际未执行的操作。

### 8.8 审批与策略

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| POLICY-001 | P0 | 只读文件操作可以按用户的 Codex 权限策略自动执行。 |
| POLICY-002 | P0 | 文件写入、删除、重命名和补丁必须进入现有审批链路。 |
| POLICY-003 | P0 | 命令审批必须显示远程主机、`cwd`、完整命令和环境变量变更。 |
| POLICY-004 | P0 | `sudo`、设备访问、进程终止和工作区外访问始终要求明确审批。 |
| POLICY-005 | P0 | `rm -rf`、`git reset --hard`、`git clean`、强制推送等破坏性命令不得被通用“始终允许”规则覆盖。 |
| POLICY-006 | P0 | 本地 Shell 或本地文件写入请求一律拒绝，并记录为路由违规。 |
| POLICY-007 | P1 | 支持按远程主机和工作区分别保存允许/拒绝规则。 |
| POLICY-008 | P1 | 审批结果绑定规范化后的参数，命令或路径变化后必须重新审批。 |

### 8.9 配置需求

Bridge 配置不得包含明文密码或私钥。建议的项目级配置如下：

```json
{
  "version": 1,
  "host": "training-gpu",
  "workspaceRoot": "/home/zkbot/work/train/MimicLite",
  "connectionMode": "openssh",
  "localExecution": "deny",
  "remoteHelper": "none",
  "commandTimeoutMs": 120000,
  "maxOutputBytes": 10485760,
  "maxParallelReads": 8,
  "maxParallelWrites": 1
}
```

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| CFG-001 | P0 | `localExecution` 固定为 `deny`，MVP 不提供关闭选项。 |
| CFG-002 | P0 | `workspaceRoot` 必须为远程规范化绝对路径。 |
| CFG-003 | P0 | SSH 密码不得写入配置；需要密码时交给 OpenSSH 交互或系统凭据存储。 |
| CFG-004 | P0 | 无配置或配置无效时保持 `disabled`，不得猜测远程目标。 |
| CFG-005 | P1 | 项目配置可以提交到仓库，但必须仅包含非敏感默认值。 |
| CFG-006 | P1 | 用户级覆盖与项目配置合并后，在诊断中显示最终生效值及来源。 |

### 8.10 生命周期与升级

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| LIFE-001 | P0 | 启动时检测官方扩展、CLI Shim 和 app-server 版本。 |
| LIFE-002 | P0 | 协议不兼容时进入 `incompatible`，不得尝试降级执行。 |
| LIFE-003 | P0 | Bridge 停止时取消活动请求并关闭 SSH 子进程。 |
| LIFE-004 | P0 | Bridge 崩溃后不得留下可继续接受命令的无主执行器。 |
| LIFE-005 | P1 | 升级前后保存并恢复用户原有 Codex 和 `remote.extensionKind` 设置。 |
| LIFE-006 | P1 | 提供版本兼容矩阵和最近一次成功诊断结果。 |
| LIFE-007 | P1 | 卸载后不保留远程辅助文件、本地临时 Token 或活动进程。 |

## 9. 安全需求

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| SEC-001 | P0 | 默认采用最小权限，访问范围仅限用户确认的远程工作区。 |
| SEC-002 | P0 | 写文件、删除文件和有副作用的命令遵循 Codex 审批策略。 |
| SEC-003 | P0 | SSH 私钥只能由本地 OpenSSH/Agent 使用，扩展不得读取或上传私钥内容。 |
| SEC-004 | P0 | 远端不得监听公网端口，不得启动无认证的 app-server。 |
| SEC-005 | P0 | 远端不得保存 ChatGPT/Codex 认证信息。 |
| SEC-006 | P0 | 路由失败时安全失败，不得自动切换到本地执行。 |
| SEC-007 | P1 | 支持命令允许/拒绝规则和完整审计记录。 |
| SEC-008 | P1 | 临时文件和辅助进程在会话结束后自动清理。 |

### 9.1 必须覆盖的威胁场景

| 场景 | 必须采取的措施 |
| --- | --- |
| 恶意仓库通过 `AGENTS.md` 要求本地执行 | 执行位置由策略层决定，仓库指令无权改变 |
| 路径包含 `..`、符号链接或绑定挂载 | 远端规范化并校验最终路径仍位于允许根目录 |
| 命令参数包含换行、引号或 Shell 元字符 | 优先使用 `argv` 数组；Shell 字符串必须单独审批 |
| SSH 主机身份变化 | 立即停止并报告 `HOST_KEY_MISMATCH` |
| 写入前文件被用户或训练进程修改 | `expectedHash` 不匹配时拒绝并报告冲突 |
| Bridge 收到未知 app-server 请求 | 默认拒绝，不透明转发可能产生副作用的请求 |
| SSH 断线后旧进程仍运行 | 标记结果未知，恢复后查询，不自动重放 |
| 日志采集包含 Token 或私钥路径 | 对敏感字段做结构化脱敏，不记录文件内容 |
| 本地存在与远程相同的绝对路径 | 文件身份始终包含 `hostId`，禁止仅按路径选择执行端 |

### 9.2 审计记录

每次有副作用的操作至少记录：

- 时间、`requestId`、`connectionId` 和会话 ID。
- 官方扩展、Bridge、Shim 和 app-server 版本。
- 远程主机指纹、工作区根目录和实际 `cwd`。
- 规范化后的操作类型与参数摘要。
- 审批结果、执行结果、退出码和耗时。
- 是否发生截断、取消、重试、连接恢复或状态未知。

审计日志默认只保存在本地 Ubuntu，并支持用户主动清理。

## 10. 非功能需求

### 10.1 性能

- 在 SSH 往返延迟不超过 50 ms 时，普通文件读取和目录列出的桥接额外延迟 P95 不超过 300 ms。
- 在 SSH 往返延迟不超过 50 ms 时，命令输出应在远端产生后 500 ms 内开始显示。
- 文件写入不应要求同步整个仓库。
- 搜索应优先在远端使用 `rg` 等已有工具，缺失时再使用兼容实现。
- 单个会话默认最多并行 8 个只读操作和 1 个写操作。
- 默认单次命令输出上限为 10 MiB，达到上限后保留尾部并明确标记截断。

### 10.2 可靠性

- 写操作应具有请求 ID，避免重连后重复应用。
- 非幂等命令不得自动重试。
- 扩展重启后能够识别遗留的远程进程和未完成调用。
- 协议字段未知时不得静默忽略可能影响执行位置或权限的字段。
- SSH 重连必须生成新的 `connectionId`，旧连接上的审批不得复用。
- 写入操作成功返回前，必须确认远端落盘结果或返回“结果未知”。

### 10.3 兼容性

- 本地首要支持可运行当前稳定版 VS Code 的 Ubuntu x86_64。
- 远端首要支持可通过 OpenSSH 登录的 Ubuntu x86_64。
- 支持 VS Code Remote SSH 工作区。
- Bridge 应声明并检查兼容的官方 Codex 扩展和 Codex CLI/app-server 版本。
- MVP 仅保证 OpenSSH 配置中的具体主机别名，不支持通配符主机作为最终目标。

### 10.4 可维护性

- 不修改官方 Codex 扩展的安装文件。
- CLI Shim、协议适配和 SSH 执行器应彼此解耦。
- app-server 协议类型应从匹配版本生成，不手写大规模协议类型。
- 远程工具应使用结构化参数，避免拼接未经转义的 Shell 字符串。
- 核心路由、路径校验、审批绑定和重连幂等性必须具备自动化测试。

### 10.5 标准错误码

| 错误码 | 含义 | 是否可自动重试 |
| --- | --- | --- |
| `BRIDGE_NOT_READY` | Bridge 不处于可执行状态 | 否 |
| `SSH_DISCONNECTED` | SSH 连接已断开 | 仅只读操作可在重连后重试 |
| `HOST_KEY_MISMATCH` | 远程主机身份变化 | 否 |
| `PATH_OUTSIDE_ROOT` | 路径逃逸工作区根目录 | 否 |
| `FILE_CONFLICT` | 文件哈希或版本不匹配 | 否 |
| `COMMAND_DENIED` | 用户或策略拒绝命令 | 否 |
| `LOCAL_EXECUTION_BLOCKED` | 检测到本地执行请求 | 否 |
| `TIMEOUT` | 操作超过配置时限 | 否，需用户确认 |
| `CANCELLED` | 用户或会话取消 | 否 |
| `PROTOCOL_MISMATCH` | 扩展、Shim 或 app-server 不兼容 | 否 |
| `OUTPUT_TRUNCATED` | 输出已达到上限 | 可继续分页读取 |
| `RESULT_UNKNOWN` | 连接中断，无法确定副作用是否完成 | 否，需人工检查 |

## 11. 建议技术方案

本节是当前建议，不替代前述需求。

### 11.1 逻辑拓扑

```text
本地 Ubuntu
┌─────────────────────────────────────────────────────────┐
│ VS Code                                                  │
│ ├─ Remote SSH 编辑窗口                                   │
│ ├─ 官方 Codex 扩展（强制在本地 UI Extension Host）       │
│ └─ Bridge 扩展                                           │
│        │ 配置、状态、路径映射、审批                       │
│        ▼                                                  │
│    CLI Shim ──JSON-RPC/stdio── 本地 Codex app-server     │
│        │                         │                        │
│        │ 动态工具调用            └─HTTPS/WSS── OpenAI     │
│        ▼                                                  │
│    Remote Executor ─────────SSH/SFTP──────────────┐       │
└───────────────────────────────────────────────────│───────┘
                                                    │
远程 Ubuntu                                         ▼
┌─────────────────────────────────────────────────────────┐
│ /home/zkbot/work/train/MimicLite                         │
│ 文件、Shell、Git、测试、训练、调试、GPU                  │
│ 无 Codex、无 ChatGPT 凭据、无公网访问                    │
└─────────────────────────────────────────────────────────┘
```

数据流方向：

1. 用户提示从 VS Code 进入本地 Codex app-server。
2. 模型请求由本地 Ubuntu 发送给 OpenAI。
3. app-server 产生远程动态工具调用。
4. CLI Shim/Bridge 在本地校验策略后，通过 SSH 操作远程 Ubuntu。
5. 工具结果返回本地 app-server，再显示在官方 Codex 界面。

### 11.2 插入点

通过官方扩展的 `chatgpt.cliExecutable` 设置，将其后端入口指向本地 CLI Shim。CLI Shim 兼容官方扩展启动 `codex app-server` 时使用的命令行和 JSON-RPC stdio 协议。

Shim 必须：

- 原样支持官方扩展传入的版本查询和 `app-server` 启动参数。
- 启动与当前兼容矩阵匹配的本地 Codex app-server。
- 代理双向 JSON-RPC，并维护请求 ID 映射。
- 在 `initialize`、`thread/start` 和 `thread/resume` 阶段注入所需能力。
- 拒绝未知且可能产生副作用的协议请求。
- 不读取、复制或转发 ChatGPT 凭据。

### 11.3 工具路由

CLI Shim 启动本地 Codex app-server，并为会话注入远程动态工具：

- `remote_read_file`
- `remote_list_directory`
- `remote_list_tree`
- `remote_search`
- `remote_write_file`
- `remote_apply_patch`
- `remote_exec`
- `remote_cancel`
- `remote_git_status`

当 app-server 发出 `item/tool/call` 时，Bridge 在本地处理请求，并通过 SSH/SFTP 操作远程 Ubuntu。

建议的核心工具参数：

| 工具 | 关键输入 | 关键输出 |
| --- | --- | --- |
| `remote_read_file` | `path`、`offset`、`limit` | 内容、哈希、大小、权限、修改时间 |
| `remote_list_directory` | `path`、`depth`、`limit` | 结构化目录项、截断游标 |
| `remote_list_tree` | `path`、`depth`、`maxEntries` | 一次调用返回的有界目录树 |
| `remote_search` | `query`、`paths`、`globs`、`maxResults` | 文件、行号、匹配片段 |
| `remote_write_file` | `path`、内容、`expectedHash`、`idempotencyKey` | 新哈希、写入字节数 |
| `remote_apply_patch` | 结构化补丁、基础哈希、`idempotencyKey` | 逐文件结果和新哈希 |
| `remote_exec` | `argv` 或已审批 Shell、`cwd`、超时、环境变量白名单 | 输出流、退出码、耗时 |
| `remote_cancel` | `requestId` | 是否终止、最终状态 |

`remote_exec` 只接受 `argv` 数组。确实需要管道、重定向或 Shell 展开时，应把
`bash -lc` 等 Shell 作为显式 `argv` 元素，并在审批界面展示完整参数。

Bridge 必须继承官方界面的当前权限语义：“完全访问”或 `approvalPolicy=never` 时，
远程命令不再重复询问；其他模式继续逐次审批。该映射只控制 Remote Executor，本地
app-server 仍固定在空控制目录和只读沙箱中，不得因此恢复本地项目执行能力。

Bridge 自有动态工具可在返回官方界面前投影为标准 `commandExecution` 项，以复用官方
读取、列目录、搜索、命令输出和审批外观。投影只改变展示协议，不改变实际工具路由、
参数校验或审计；不得修改官方扩展文件，也不得改写不属于 Bridge 的第三方动态工具。

本地 app-server 配置的 MCP、App 和 Connector 服务继续允许远程工作区任务调用。
Bridge 在 Remote SSH 窗口中扫描本机已启用的 MCP，但只在以下条件全部满足时把
stdio 服务进程通过当前 SSH 目标启动：配置不含环境变量和本地 `cwd`、命令不是
包管理器或通用运行时、远端可探测到同名直接可执行文件。HTTP 服务和不满足条件的
stdio 服务继续留在本机，不得向远端复制 Token 或环境变量。

该路由只覆盖当前 app-server 进程的 MCP `command`/`args`，不得修改全局
`~/.codex/config.toml`，也不得改写未知 MCP 工具的参数语义。工作区参数差异通过
显式适配器处理；当前 CodeGraph 适配器把索引根目录绑定到远程工作区。用户必须能够
按窗口关闭自动路由。项目 Shell、Git、测试和训练命令仍统一走 `remote_exec`。

### 11.4 路径模型

禁止仅用字符串绝对路径区分本地和远程文件。内部文件身份必须表示为：

```text
RemotePath {
  hostId: "training-gpu",
  workspaceRoot: "/home/zkbot/work/train/MimicLite",
  relativePath: "README.md"
}
```

路径处理规则：

1. 接收路径后先转换为远程 POSIX 路径。
2. 在远程端解析 `.`、`..` 和符号链接。
3. 校验最终路径仍位于远程工作区根目录。
4. 执行文件操作。
5. 返回远程规范化路径和文件哈希。
6. 映射为当前 Remote SSH 窗口能够打开的 VS Code URI。

本地 app-server 使用独立空控制目录。不得因为本地存在同名 `/home/zkbot/work/train/MimicLite` 就把它当作远程项目。会话中的远程 `cwd` 由 Shim 单独维护，必要时对 app-server 请求和响应做双向路径映射。

### 11.5 执行位置控制

- Codex app-server、ChatGPT 登录和模型网络位于本地 Ubuntu。
- Remote Executor 位于本地 Ubuntu，通过 SSH 主动连接远程 Ubuntu。
- 远程 Ubuntu 只执行标准文件和 Shell 操作。
- 本地 app-server 运行在无项目文件、不可写、禁止项目命令的控制环境中。
- 系统指令明确要求项目操作只使用远程工具。
- 即使模型选择错误工具，也必须由策略层阻止本地执行。
- 任何本地 `commandExecution` 或项目 `fileChange` 事件均视为路由违规，立即拒绝并终止当前工具调用。

仅使用提示词约束不满足本需求。若无法从配置、审批层或操作系统沙箱可靠阻止本地命令，则必须修改开源 Codex Core，增加明确的远程执行后端。

### 11.6 官方扩展运行位置

可行性验证需要测试通过 `remote.extensionKind` 将 `openai.chatgpt` 强制运行在本地 UI 扩展宿主。若官方扩展依赖远程 Node.js 文件系统或无法正确处理远程 URI，则记录为阻塞项，不通过修改官方扩展文件规避。

验证项目：

- 官方扩展进程和 CLI Shim 是否实际位于本地。
- 当前编辑文件和选区能否传递给本地运行的官方扩展。
- 远程文件链接、Diff、审批和会话恢复是否正常。
- 官方扩展更新后 `chatgpt.cliExecutable` 是否仍生效。

### 11.7 协议兼容策略

- 从目标 Codex 版本运行 `codex app-server generate-ts --experimental` 生成类型。
- 以官方扩展版本、Codex 版本和协议能力组成兼容矩阵。
- 启动时完成 `initialize` 探测，确认动态工具和必要请求类型可用。
- 对未知通知可以记录后转发；对未知请求默认拒绝。
- 不通过删除字段或猜测默认值掩盖协议不兼容。

### 11.8 备选方案

若官方扩展无法稳定使用 CLI Shim，则保留 Bridge 的 SSH 执行器和协议层，改为实现一个独立 VS Code Codex 客户端，直接连接开源 Codex app-server。此方案不再复用官方扩展界面，但仍使用本地 ChatGPT Codex 登录和额度。

## 12. 验收测试

### 12.1 环境与认证

1. 在本地 Ubuntu 登录 ChatGPT，远程 Ubuntu 不配置任何 OpenAI 凭据。
2. 在远程 Ubuntu 执行 `command -v codex`，结果应为空。
3. 发起 Codex 任务，确认 OpenAI 网络连接来自本地 Ubuntu。
4. 检查远程 Ubuntu 进程，确认没有 Codex CLI/app-server。
5. 记录两台主机的 `hostname` 和 `/etc/machine-id`，后续命令结果据此判定执行位置。

### 12.2 文件操作

1. 请求 Codex 读取远程 `README.md` 并返回摘要。
2. 请求 Codex 修改一个测试文件。
3. 在远程 Ubuntu 上计算文件哈希，确认实际文件已变化。
4. 在 VS Code 中打开 Diff，确认路径指向远程工作区。
5. 制造并发修改，确认 Bridge 拒绝覆盖并报告冲突。
6. 尝试访问工作区外文件，确认请求被拒绝。
7. 在本地创建同名诱饵文件，确认读取和写入仍只发生在远程文件。

### 12.3 命令执行

1. 请求执行 `pwd`，结果必须为远程工作区路径。
2. 请求执行 `uname -a`，结果必须来自远程 Ubuntu。
3. 请求执行 `git status --short`，结果必须对应远程仓库。
4. 请求执行 `nvidia-smi`，结果必须来自远程 GPU 环境。
5. 启动长命令，验证流式输出和取消功能。
6. 请求执行带空格、引号和换行参数的命令，确认参数未被错误重新解释。

### 12.4 安全失败

1. 执行过程中断开 SSH。
2. Bridge 应立即报告远程连接失败。
3. 本地 Ubuntu 不得出现同名命令的本地执行记录。
4. 重新连接后，非幂等命令不得自动重试。
5. 注入未知 app-server 请求，确认 Bridge 默认拒绝。
6. 修改 SSH 主机密钥测试配置，确认 Bridge 进入 `disconnected` 或 `incompatible`，不继续执行。

### 12.5 会话与升级

1. 创建会话，执行远程读写后关闭 VS Code。
2. 重新打开同一远程工作区并继续会话。
3. 确认恢复后的 `hostId` 和 `workspaceRoot` 与原会话一致。
4. 更改远程目标后尝试继续旧会话，系统必须要求重新确认，不得静默切换。
5. 模拟官方扩展或 app-server 版本不匹配，确认 Bridge 进入 `incompatible`。
6. 执行恢复命令，确认用户原有 `chatgpt.cliExecutable` 和 `remote.extensionKind` 设置恢复。

### 12.6 验收证据

每次可行性验证必须保存以下非敏感证据：

| 证据 | 用途 |
| --- | --- |
| 本地和远程进程列表摘要 | 证明 Codex 仅在本地运行 |
| 本地和远程网络连接摘要 | 证明 OpenAI 流量仅从本地发出 |
| Bridge 诊断报告 | 记录版本、主机指纹、路径映射和状态 |
| 工具审计日志 | 证明每次操作的实际执行主机 |
| 远程文件前后哈希 | 证明修改落在远程工作区 |
| 本地诱饵文件哈希 | 证明没有本地错误写入 |
| SSH 断线测试记录 | 证明系统安全失败 |

验收材料不得包含 Token、私钥、完整环境变量或敏感项目文件内容。

### 12.7 P0 通过矩阵

| 能力 | 预期 | 失败判定 |
| --- | --- | --- |
| 官方界面 | 可以创建任务、查看输出和审批 | 必须修改官方扩展文件 |
| 本地认证 | ChatGPT 登录和额度正常 | 需要 API Key 或远端登录 |
| 远程读取 | 内容来自指定远程主机 | 读取本地同名路径 |
| 远程写入 | 远程哈希变化、本地诱饵不变 | 本地出现项目修改 |
| 远程命令 | `hostname`、Git、GPU 均来自远端 | 任一项目命令在本地执行 |
| 安全失败 | 断线后停止且不重放 | 自动本地回退或重复副作用 |
| 远端纯净 | 无 Codex、无 Token、无公网依赖 | 远端需要安装或登录 Codex |

## 13. MVP 范围

首个 MVP 仅支持：

- 单个本地 Ubuntu 主机。
- 单个远程 Ubuntu SSH 主机。
- 单个远程工作区根目录。
- SSH Key/Agent 认证。
- 远程文件读取、搜索、补丁和写入。
- 非交互式远程 Shell、Git 和测试命令。
- 流式输出、取消和基本审批。
- 本地 ChatGPT 登录和 Codex 额度。
- 明确的状态、日志和安全失败。

以下功能推迟到 MVP 之后：

- 多主机、多根工作区。
- 交互式终端和复杂后台任务。
- 调试器协议代理。
- 端口自动转发。
- 文件离线缓存和双向同步。
- 团队策略集中管理。

### 13.1 分阶段实施

#### 阶段 A：协议与运行位置探针

- 验证 `remote.extensionKind` 能否让官方扩展运行在本地。
- 验证 `chatgpt.cliExecutable` 能否稳定指向 CLI Shim。
- 完成 app-server `initialize`、`thread/start` 和消息转发。
- 证明远程 Ubuntu 不启动 Codex。

退出条件：能使用官方界面与本地 app-server 完成一个不访问项目的对话。

#### 阶段 B：远程只读

- 实现主机识别、工作区根目录和 SSH 生命周期。
- 实现目录、文件、搜索和元数据工具。
- 完成路径限制、符号链接防逃逸和审计日志。
- 验证当前文件、选区和远程文件链接。

退出条件：Codex 能分析 MimicLite，但不能写文件或执行命令。

#### 阶段 C：远程写入与命令

- 实现哈希保护的写入和结构化补丁。
- 实现非交互式远程命令、流式输出和取消。
- 实现审批绑定、本地执行阻断和断线安全失败。

退出条件：通过第 12.7 节全部 P0 验收项。

#### 阶段 D：可靠性与发布

- 实现重连、会话恢复、升级兼容和设置恢复。
- 完成自动化测试、安全审查和性能测试。
- 打包可复现 VSIX 和 CLI Shim 发布物。

退出条件：连续日常使用期间无本地误执行、无重复副作用和无凭据泄漏。

### 13.2 交付物

- Bridge VS Code 扩展 VSIX。
- CLI Shim 的本地 Ubuntu 可执行文件。
- app-server 协议生成类型和版本兼容矩阵。
- Remote Executor 与结构化工具 Schema。
- 单元测试、集成测试和端到端验收脚本。
- 安装、诊断、恢复和卸载文档。
- 威胁模型与安全审计说明。
- 已知限制和官方扩展升级适配说明。

### 13.3 最低测试覆盖

| 模块 | 必须覆盖 |
| --- | --- |
| 路径映射 | 相对路径、绝对路径、`..`、符号链接、同名本地路径 |
| SSH 执行 | 成功、非零退出、超时、取消、断线、输出截断 |
| 文件写入 | 新建、修改、删除、哈希冲突、原子替换 |
| 协议代理 | 请求 ID 映射、未知请求、通知转发、版本不匹配 |
| 审批策略 | 参数绑定、破坏性命令、本地执行拒绝 |
| 生命周期 | 启动、停止、崩溃、重连、升级、卸载与设置恢复 |

## 14. 可行性验证决策点

验证结束后按以下标准决策：

| 结果 | 决策 |
| --- | --- |
| 官方扩展能在本地运行，CLI Shim 和远程路径映射稳定 | 继续实现 Bridge 扩展 |
| 核心功能可用，但偶发使用本地工具或路径映射错误 | 修改开源 Codex Core，增加远程执行后端 |
| 官方扩展无法可靠连接 Shim，或升级频繁破坏协议 | 实现独立 VS Code app-server 客户端 |
| 无法证明远端无 Codex、无凭据或无法安全失败 | 停止方案，不进入日常使用 |

## 15. 已知风险

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| `chatgpt.cliExecutable` 是开发用途设置 | 官方升级后 Shim 无法启动 | 版本兼容矩阵、启动探针、保留设置恢复入口 |
| app-server 动态工具仍是实验接口 | 字段或调用流程变化 | 从目标版本生成 Schema，未知副作用请求默认拒绝 |
| 官方扩展闭源 | 无法确认所有文件访问路径 | 运行位置探针、诱饵文件测试、失败时切换独立客户端 |
| 强制扩展运行在本地 | 文件附件、Diff 或链接失效 | 阶段 B 单独设门，不通过则停止官方界面方案 |
| 模型选择内置本地工具 | 项目命令误在本地执行 | 空控制目录、只读沙箱、策略拒绝，必要时修改开源 Core |
| SSH 延迟和大量小文件 | 分析速度明显下降 | 远端搜索、批量读取、结果分页和有界并发 |
| SSH 断线时远端命令继续 | 副作用结果未知 | 远程进程 ID、取消协议、返回 `RESULT_UNKNOWN`、禁止自动重放 |
| 本地与远程路径相同 | 写错机器且难以察觉 | `hostId` 参与文件身份，本地诱饵验收，禁止纯路径路由 |

## 16. 待确认事项

| 编号 | 待确认事项 | 当前建议 | 对 MVP 的影响 |
| --- | --- | --- | --- |
| DEC-001 | 是否允许在本地 Ubuntu 安装配套 CLI Shim | 已确认允许，它是复用官方界面的必要入口 | 已确认 |
| DEC-002 | 是否允许远程 Ubuntu 运行无 Codex、无公网能力的临时辅助进程 | MVP 不依赖，仅使用 OpenSSH/Shell | 不阻塞 |
| DEC-003 | MVP 是否必须支持交互式训练命令和后台任务 | 否，先支持非交互命令、流式输出和取消 | 不阻塞 |
| DEC-004 | 是否需要支持 MimicLite 之外的仓库 | 架构通用，MVP 仅验收 MimicLite | 不阻塞 |
| DEC-005 | 官方扩展不兼容时是否接受独立 Codex VS Code 客户端 | 接受，作为明确备选路线 | 阻塞最终路线选择 |
| DEC-006 | 是否允许 Bridge 临时修改并在退出时恢复 `remote.extensionKind` | 已确认允许自动配置；单根远程目录视为范围选择，必须备份和可恢复 | 已确认 |
| DEC-007 | 审计日志默认保留周期 | 建议 7 天，可手动清理 | 不阻塞 |

DEC-001 和 DEC-006 已由用户确认。DEC-005 仍是官方兼容性路线的最终待确认项。

## 17. 参考资料

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex IDE Developer Settings](https://developers.openai.com/codex/ide/settings)
- [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code Remote Extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
