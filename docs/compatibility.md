# 兼容矩阵

更新日期：2026-08-02

当前源码是“官方扩展内置运行时”候选，本次实测来源为
`openai.chatgpt@26.727.40816` 及其内置 Codex `0.146.0-alpha.9.2`。Windows x64 已完成
Executor 配套版本自动同步、官方新任务、当前 Shim、远端项目操作，以及 `0.3.62`
异步前台执行、`0.3.61`
统一工具路由清单、`0.3.60` Windows Git 初始化 watcher 可逆兼容、npm 普通入口、显式外部 CLI/MCP、历史 thread
恢复、无 rollout 冷启动降级、停用恢复和 npm 覆盖恢复实测；既有 Linux x64
候选包、普通本地外部 `full-access`、Remote SSH 外部 CLI、固定远端工具和 CodeGraph
链路证据继续有效。完整双平台发布门禁仍待补测。Bridge 不固定官方扩展版本号；系统
Codex CLI 仅作为可选外部客户端按能力探测，不固定版本，也不替代官方扩展内置运行时。
2026-07-18 的 `0.144.5` 组合仍是最近一次完成 Windows 主链路验收的支持基线；候选
自动化通过不等于发布支持。

| 组件 | 已探测版本 | 当前策略 | 状态 |
| --- | --- | --- | --- |
| VS Code | `1.129.1`（Windows x64）；`1.130.0`（既有 Linux x64 候选环境） | 扩展引擎最低 `^1.96.2` | Windows 官方任务和既有 Linux 官方面板/外部 CLI Remote SSH 任务通过 |
| 官方 Codex 扩展 | 本次探测 `openai.chatgpt@26.727.40816` | 固定扩展 ID，不固定版本；使用 VS Code 当前实际加载版本 | Windows Remote SSH 官方新任务到达当前 Shim，并完成远端文件、Git 与命令操作；普通本地和既有外部 CLI 链路通过 |
| Bridge Controller | `0.3.62` Windows x64 候选；`0.3.51` Linux Remote SSH 候选；`0.2.7` Windows 支持基线 | 同一扩展 ID；Linux/Windows 必须原生构建并以受控 stage 收集，禁止异平台启动器交叉构包 | `0.3.62` 已安装在 Windows x64；跨 Extension Host 前台执行采用快速确认和异步有序事件，五次真实远端调用为 `177–299 ms`、无超时；外部 MCP 特定客户端名称的冷初始化仍待修复，完整双平台门禁待补测 |
| Remote Executor | `0.2.21`，诊断协议 13，Linux x64 Workspace 候选 | Workspace 扩展；每次初始化比较远端扩展清单实际包版本与 Controller 内嵌配套版本，不一致时通过活动 Remote SSH 通道自动部署并重载；ping 仍按所需能力集合验收，不按包版本或协议号门禁 | 新增 `executeAsyncEvents` 能力；Windows Controller 自动安装 `0.2.21` 并按预期重载一次，扩展上下文随后回报包版本与运行版本均为 `0.2.21`，没有重复升级循环 |
| 官方扩展内置 Codex/app-server | 本次探测 `0.146.0-alpha.9.2` | 只从当前官方扩展安装目录启动；版本仅作诊断和协议快照索引 | Windows 直接参数探针复现并修复 `AbsolutePathBuf` 错误；真实官方 Remote SSH task、普通本地和既有外部 CLI thread 通过 |
| 系统 Codex CLI | 本次 Windows 探针 `0.146.0`，不固定 | 仅用于 MCP 和外部客户端；POSIX 接管实际 symlink，Windows 仅成组接管同一 npm 目录中的三种普通 wrapper；运行时探测所需参数，官方扩展内置 app-server 仍是唯一服务端 | Windows 普通 `codex` 自动附着、无匹配透传、PowerShell/CMD 参数透传、停用恢复和真实 npm 覆盖恢复通过；Git Bash 未安装，extensionless wrapper 仅完成内容与自动化验证 |
| Remote SSH | `0.124.0` | 使用 `remote.extensionKind` 探针设置 | 活动 transport、远程主根和 Bridge 动态工具已通过；CodeGraph 远端 server 路由已配置，具体工具仍以当前 app-server 工具快照为准 |
| OpenSSH 客户端 | Linux `9.6p1`；Windows 支持基线 `9.5p2` | 严格主机校验、user/port/IdentityFile；ControlMaster 仅 Linux 启用 | 本次未触发 OpenSSH 回退实机链路 |

完整的升级触发条件、硬门禁、量化指标和分平台声明规则见
`docs/upgrade-tracking.md`。当前插件内置运行时候选证据见
`docs/acceptance/2026-07-22-release-0.2.7.md`，MCP 适配跟进证据见
`docs/acceptance/2026-07-22-release-0.2.7-mcp-adapter.md`，远程逻辑主根与逐轮路由见
`docs/acceptance/2026-07-22-release-0.2.7-remote-primary-root.md`；当前 CLI MCP 候选见
`docs/acceptance/2026-07-23-release-0.3.0-external-cli-mcp.md`，双向实时候选见
`docs/acceptance/2026-07-23-release-0.3.1-bidirectional-cli.md`，最新协议升级候选见
`docs/acceptance/2026-07-23-release-0.3.2-bundled-protocol.md`，最新 Remote SSH 外部
CLI 实机证据见
`docs/acceptance/2026-07-23-release-0.3.3-remote-cli-acceptance.md`，退出码投影修复见
`docs/acceptance/2026-07-23-release-0.3.4-native-exit-code.md`，多上游单次执行见
`docs/acceptance/2026-07-23-release-0.3.5-single-tool-execution.md`，正常关闭见
`docs/acceptance/2026-07-23-release-0.3.6-graceful-gateway-close.md`，设置恢复空闲态见
`docs/acceptance/2026-07-23-release-0.3.8-settings-restore-idle.md`，分阶段重新配置见
`docs/acceptance/2026-07-23-release-0.3.10-staged-reconfigure.md`，历史 thread 恢复见
`docs/acceptance/2026-07-23-release-0.3.11-historical-thread-resume.md`，根身份协议见
`docs/acceptance/2026-07-23-release-0.3.12-root-identity-protocol.md`，本地根授权执行器见
`docs/acceptance/2026-07-23-release-0.3.13-local-root-authority.md`，双端只读路由见
`docs/acceptance/2026-07-23-release-0.3.14-dual-read-routing.md`，运行中命令取消见
`docs/acceptance/2026-07-23-release-0.3.15-command-cancellation.md`，幂等账本见
`docs/acceptance/2026-07-23-release-0.3.16-idempotency-ledger.md`，断线查询恢复见
`docs/acceptance/2026-07-23-release-0.3.17-disconnect-recovery.md`，Core 风险命名空间
双端写入候选见 `docs/acceptance/2026-07-24-release-0.3.19-dual-write.md`；后台任务候选见
`docs/acceptance/2026-07-24-release-0.3.20-background-tasks.md`；远程资源候选见
`docs/acceptance/2026-07-24-release-0.3.21-workspace-resources.md`；双原生产物收集见
`docs/acceptance/2026-07-24-release-0.3.22-native-artifact-collection.md`；风险命名空间
阻断见 `docs/acceptance/2026-07-24-release-0.3.18-core-risk-namespaces.md`；上一支持基线见
`docs/acceptance/2026-07-18-release-0.2.7.md`。当前普通本地外部 `full-access` 消息
修复及 Linux 本地/Remote SSH 实机见
`docs/acceptance/2026-07-26-release-0.3.33-local-full-access.md`；当前活动 VS Code
transport 关闭终结修复及 Linux Remote SSH 实机见
`docs/acceptance/2026-07-26-release-0.3.34-transport-close.md`；当前 Executor 独立
失联响应、写入短流和死亡拥有者清理见
`docs/acceptance/2026-07-27-release-0.3.37-executor-loss-response.md`。
当前普通 CLI 工作区选择和跨目录透传证据见
`docs/acceptance/2026-07-27-release-0.3.43-plain-cli-workspace-selection.md`；当前
Remote SSH 任务列表隔离见
`docs/acceptance/2026-07-28-release-0.3.45-remote-task-list-scope.md`；远程
Codegraph MCP 工具身份和真实 `codegraph_explore` 见
`docs/acceptance/2026-07-28-release-0.3.46-remote-mcp-tool-guidance.md`；当前 Windows
Executor 同步、任务创建和稳定性证据见
`docs/acceptance/2026-07-31-release-0.3.52-executor-package-reconciliation.md`。
Windows 外部 CLI/MCP 与无 rollout 冷启动证据见
`docs/acceptance/2026-08-02-release-0.3.58-windows-external-cli.md`；Windows npm 普通入口、
停用恢复与 npm 覆盖恢复见
`docs/acceptance/2026-08-02-release-0.3.59-windows-automatic-cli.md`；Windows 官方 Git
初始化 watcher 兼容、重载和远端只读链路见
`docs/acceptance/2026-08-02-release-0.3.60-windows-git-init-watcher.md`；Windows 统一工具
路由清单、状态语义和真实远端默认路由见
`docs/acceptance/2026-08-02-release-0.3.61-windows-tool-route-inventory.md`；Windows 前台命令
异步事件回传、五次真实调用和分段耗时见
`docs/acceptance/2026-08-02-release-0.3.62-windows-async-execute.md`。

当前协议文件位于 `protocol/0.146.0-alpha.3/`。`ServerRequest.json` 的方法集合由自动化测试与
Shim 的已知请求白名单逐项比对；出现新请求时测试失败，而不是静默转发潜在副作用。
`ThreadStartParams`、`ThreadResumeParams` 和 `TurnStartParams` 固定逐轮应用上下文所依赖的
字段；Remote SSH app-server 进程仍在本地控制目录启动。POSIX 主机沿用远端逻辑主根作为
runtime root；Windows app-server 使用原生控制目录作为 runtime root，远端 POSIX 主根由
Bridge 策略、附加上下文与动态工具承载。普通
本地窗口使用原始工作目录且不执行远程请求改写，仅共享 app-server 和外部附着网关。
Bridge 另外使用该版本的 `commandExecution` 项、命令审批请求和输出增量字段。外部
新 thread 的完全访问使用 `sandbox=danger-full-access` / `approvalPolicy=never`；
Remote SSH 请求再按目标策略映射为 Bridge 权限档案，把动态工具投影成官方原生外观
并同步审批行为。MCP 路由器仅在 Remote SSH 窗口内扫描本机配置，并可
按窗口覆盖 MCP 的 `enabled`、`disabled_tools` 和 `default_tools_approval_mode`，
把无凭据且远端存在同名可执行文件的 stdio 服务按当前 Bridge 目标覆盖为远端启动；
默认模式复用 VS Code Remote 通道，OpenSSH 模式使用独立 SSH stdio 中转，
其他 MCP 和本地窗口仍使用用户原有配置。Controller 通过官方扩展 API 获取安装目录，
记录扩展和内置 Codex 版本后保存受限运行时指针；两个版本字段允许未知，也不参与
Controller 或 Shim 的运行时接纳。旧配置、PATH、`~/.local/bin` 和全局 npm 安装均不会
改变运行时选择。官方扩展升级会触发协议差异审查和回归，但不会仅因版本变化拒绝启动。

Controller `0.3.x` 在 MCP override 中显式传递本地会话配置路径和受控适配器 ID，
relay 再从受限文件读取 IPC 端点和随机令牌；环境值不进入 app-server 参数或审计。
`0.146.0-alpha.3` 相对上一内置协议仍保持 11 个服务端请求，动态工具及 Bridge 使用的
线程/turn 顶层字段不变；客户端新增 `thread/searchOccurrences`、`app/read` 和
`app/installed` 三个读取请求。新兼容集合已在真实 Remote SSH 外部 CLI turn 中重跑
远程命令、远程文件读取和 CodeGraph stdio MCP。

`openai.chatgpt@26.715.31925` 曾对本地 Extension Host 中的 Remote SSH 工作区 URI
返回 `Unknown local project`；`26.721.41059` 随后证明普通本地已有 thread 可恢复、
Remote SSH 官方面板可创建新任务，且外部 CLI 可介入同一 thread。当前探测的
`26.727.40816` / `0.146.0-alpha.9.2` 在 Windows 无法反序列化 POSIX
`runtimeWorkspaceRoots`，`0.3.52` 改用真实 Windows 控制目录后，官方新任务及远端
文件、Git、命令操作已通过。Bridge 不会通过伪造或改写 VS Code 工作区 URI 绕过项目
校验；每次新的官方扩展兼容集合仍必须单独执行任务创建验收。

## 升级步骤

1. 从 `docs/acceptance/release-template.md` 创建候选版本记录，填写全部组件版本、执行人、
   变更摘要和命中的升级触发项。
2. 保留旧 VSIX 和当前设置快照，记录升级前的 Shim、Executor 与官方设置状态。
3. 官方扩展更新时记录实测版本并重跑界面链路；只有其内置 Codex 版本或生成 Schema
   变化时才运行 `npm run protocol:generate`。脚本从最新安装的官方扩展生成诊断快照；
   审查新增/删除服务端请求、动态工具字段和 MCP 启动行为，不生成版本门禁。
4. 运行命中触发项的定向测试，再运行 `npm run check`，记录通过、失败、跳过和耗时。
5. 在 Linux 与 Windows 原生 x64 主机分别运行 `npm run check` 和
   `npm run package:stage`，再运行 `npm run package:all` 收集两个 stage，核对包内版本、
   平台 Shim、嵌入 Executor、大小和 SHA-256；清理 `dist/` 历史版本但保留当前产物。
6. 按本地平台分别执行 `docs/upgrade-tracking.md` 的分平台矩阵。没有 Linux 实机结果时
   必须写“Linux 打包通过、运行时待补测”。
7. 在隔离 Remote SSH 工作区重跑受影响的官方任务、远端操作、MCP、生命周期和安全
   失败链路，检查 Codex 日志与 Bridge 审计日志。
8. 采集量化指标；不足最低样本数的值只能作为参考，不能宣称无性能回归。
9. 更新本文件和 `docs/implementation-status.md`，在候选记录中给出支持范围、遗留风险
   和最终结论。

官方扩展缺失、身份错误、所需能力缺失或消息结构不兼容时，Bridge 进入
`incompatible`，不会尝试猜测字段或降级执行；任何组件的版本值变化都不会单独触发
拒绝。
