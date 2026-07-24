# 统一人工补测清单

更新日期：2026-07-24

## 执行约定

本文只收集无法由当前自动化、静态包核对或 Linux 本机构造替代的人工/实机证据。
下面所有项目统一保留为 `待补测`，不阻塞源码实现顺序；当前已打开的 `test_40` /
Zklab Remote SSH 会话可由 Codex 通过插件注入执行无需安装或重载的探针并提前积累证据，
最终候选安装、手动重载和完整 UI 操作仍在全部能力落实后按本文统一收口。

- 不为中间开发版本反复安装 VSIX；统一安装最终候选。
- 新建 Remote SSH 连接、窗口重载和官方 UI 操作由用户执行；当前已认证窗口优先复用，
  不启动第二条 SSH 认证链路。
- Windows x64 与 Linux x64 分开记录，构包结果不得替代对应平台运行时。
- 每项必须保存脱敏后的 Codex 日志、Bridge 输出、审计摘要和量化结果。
- 不记录密码、私钥、Token、完整环境变量或 transport 会话令牌。

## A. Linux 本地与 Remote SSH

### M01 候选安装与官方任务

- 安装最终 Linux x64 Controller VSIX，确认 Remote Executor 自动升级到候选要求版本。
- 冷启动和热启动各 3 次，记录到达 `ready` 的 P50、最大值及失败数。
- 从官方 Codex 面板分别新建和恢复任务各 3 次，确认无 `Unknown local project`。
- 确认任务进入当前 Shim，`initialize`、`thread/list`、`thread/start` 和
  `thread/resume` 成功。
- 确认普通本地窗口仍使用原始本地项目语义，不被 Remote SSH 配置改写。

### M02 项目根、附件与 Core 本地诱饵

- 在官方 UI 新建和恢复任务中确认远程主根显示正确，本地控制目录不显示为项目根。
- 分别附加当前远程文件、普通附件和当前编辑器文件，确认 URI、路径与内容来源正确。
- 在本地控制目录和本地授权根放置同名诱饵，要求模型读取、修改、搜索和执行项目命令；
  Remote SSH 任务中的本地 Core Shell/文件/Git 操作数必须为 0。
- 覆盖已知客户端请求阻断、Core 审批阻断和专用模型工具路径；失败结果必须进入审计。
- 恢复普通本地任务，确认上述限制没有污染本地窗口的正常项目操作。

### M03 双端根选择与只读路由

- 通过命令面板选择本地次级根，重载后确认授权持久化、诊断可见且主次角色正确。
- 同一任务交替执行本地/远程读取、目录树、字面搜索和 Git 状态。
- 撤销本地根后，既有执行器和新请求都必须立即失败关闭；重新授权后恢复。
- 固定远端读取、目录树、搜索、Git 和 `pwd` 各执行至少 5 次，成功率必须为 100%。
- 审计中的目标端、根 ID、角色、规范化路径和 `remoteCwd` 必须与实际执行端一致。

### M04 双端安全写入

- 同一任务交替在本地授权根和远程工作区执行写入、补丁、建目录、重命名和删除。
- 使用过期 `expectedHash` 至少 5 次，必须全部返回 `FILE_CONFLICT` 且原文件不变。
- 验证原子替换、权限错误、目标已存在、部分失败和单次写入上限；不得留下临时半写文件。
- 非完全访问模式逐项核对重要操作审批；`full-access` 自动放行但仍有审批结果审计。
- 远程断线、窗口重载和 Executor 失联时写入必须失败关闭，不得切换到 OpenSSH 或本地。

### M05 远程资源、Diff 与跳转

- 从 Bridge 工具结果打开远程文件，确认使用当前 Remote SSH URI 且没有合成工作区根。
- 检查本地/远程同名文件的打开、定位、行号跳转和 Diff 左右端身份。
- 对已撤销根、越界路径、已关闭窗口和过期资源执行打开/Diff，必须明确失败。
- 在官方 UI 中确认命令项、文件名、目标端、路径和错误提示没有混淆。

### M06 远程命令审批与运行中取消

- 在 `full-access` 和至少一种需审批模式下分别执行远程命令，核对权限继承和审批内容。
- 从官方 UI 和附着 CLI 两个方向各取消长命令至少 3 次。
- 每次记录 `turn/interrupt` 到 `CANCELLED` 的耗时，并确认远端完整进程树消失。
- 等待审批时取消不得启动远端进程；取消确认失败必须返回 `RESULT_UNKNOWN`。
- OpenSSH 回退的取消限制必须清晰呈现，不得伪装成远端进程树已确认终止。

### M07 幂等、断线与结果确认

- 相同幂等键重复提交至少 5 次，副作用必须恰好发生 1 次且终态一致。
- 同键修改参数至少 5 次，必须全部拒绝且不产生新副作用。
- completed、cancelled、failed、running 和 unknown 五种状态各制造至少 5 次
  transport 中断，记录确认耗时和副作用次数。
- 断开首次状态查询 socket，确认后续查询可恢复；unknown 或查询不可达必须返回
  `RESULT_UNKNOWN`，不得重发原命令。
- 分别覆盖账本过期、Remote Executor 失联和 Extension Host 重启，确认未知边界。

### M08 后台任务

- 启动、查询状态、增量读取日志、取消和清理后台任务，覆盖成功、失败、超时和输出截断。
- 关闭调用客户端后任务按声明策略继续或终止，不得出现身份丢失或重复启动。
- 窗口关闭、Extension Host 退出和 Bridge 停止后，遗留后台进程数必须为 0。

### M09 stdio MCP

- 确认合格远端服务进入 `remoteMcpServers`，不合格或含凭据服务继续留在本机。
- `initialize`、`tools/list` 各执行 3 次，固定 `tools/call` 至少 5 次且
  `isError=false`。
- 验证 `remoteMcpAccess=enabled/all`、适配器参数和工具 allowlist 的真实效果。
- relay 断开、窗口关闭和扩展停用后，远端 MCP 子进程和本地 relay 遗留数必须为 0。
- 默认 `vscode-remote` 模式不得出现第二次 SSH 认证或密码提示。

### M10 外部 CLI 与官方 UI 双向同 thread

- CLI 和官方 UI 两端各发起一次新 turn、steer 和取消，核对 thread/turn ID 与事件顺序。
- 两端同时观察流式文本、工具状态、命令输出、终态和完整历史，确认无重复通知。
- 覆盖 `expectedTurnId` 冲突、CLI 中途断开、网关重启、过期描述符和权限撤销。
- 验证 `full-access` 不产生 Bridge 二次审批，其他模式不被外部 CLI 升权。
- 插件升级后验证 `codex-vscode` 和普通 `codex` 托管入口迁移及重新附着。
- CLI 项目写入必须复用同一目标端、根 ID、`expectedHash`、审批、幂等与审计链。

### M11 生命周期、设置恢复与安全扫描

- 覆盖旧 Shim/Executor 迁移、必要重载、独立停止、恢复驱动停止和重新启用。
- 分别执行客户端断开、Controller 停止、relay 断开、窗口关闭和 Extension Host 退出。
- 每种关闭方式核对 Shim、relay、MCP、后台任务和远端命令遗留进程数。
- 对比升级前后 `chatgpt.cliExecutable` 与 `remote.extensionKind`，恢复后差异必须为 0。
- 扫描日志、审计、进程参数、MCP 配置、远端环境和仓库，敏感信息命中数必须为 0。
- 确认远端 `codex`/app-server 进程数为 0，错误本地项目操作数为 0。

## B. OpenSSH 回退

### M12 显式 OpenSSH 链路

- 仅在用户显式选择 `openssh` 后建立连接，验证严格主机密钥、user、port 和
  IdentityFile 路径边界。
- 验证远端读、搜、Git、受审批命令和支持的写入操作；本地次级根必须失败关闭。
- 验证远端 MCP stdio 控制头与适配器，不复制本机环境或凭据。
- Linux 核对 ControlMaster 建立、复用、`-O exit` 和 socket 清理。
- 单独记录取消、断线和结果未知限制，不得套用 VS Code Remote 的账本声明。

## C. Windows x64

### M13 Windows 原生构建与运行

- 在 Windows x64 原生执行依赖安装、类型检查、测试、构建、SEA Shim 冒烟和构包。
- 安装 Windows Controller VSIX，确认只使用 `.exe` Shim，包内没有 Linux CJS Shim。
- 重跑 M01-M11 中所有平台相关链路，不得复用 Linux 结果。
- 特别核对 Named Pipe、官方任务创建、Remote SSH、进程树取消、MCP relay、设置恢复、
  CLI 托管入口、远程 URI/Diff 和双端写入。
- Windows 与 Linux 的版本、日志、指标和最终结论分别记录。

## D. 最终 P0

### M14 MimicLite 真实项目闭环

- 在目标 Remote SSH 主机与 MimicLite 仓库完成官方任务新建、恢复和多轮执行。
- 覆盖读取、搜索、Git、命令、MCP、双端写入、远程 Diff、后台任务、取消和断线恢复。
- 确认所有项目操作位于预期目标端，无第二次认证、无远端 Codex、无本地项目误操作。
- 按 G0-G9 和必填量化指标生成最终不可覆盖的候选验收记录。
- Linux 与 Windows 均满足支持声明后，才更新兼容矩阵中的最终支持范围。
