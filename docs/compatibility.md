# 兼容矩阵

更新日期：2026-07-23

当前源码是“官方扩展内置运行时”候选，本次实测来源为
`openai.chatgpt@26.715.61943` 及其内置 Codex `0.145.0-alpha.27`。Remote SSH
新任务、远端命令、CodeGraph MCP 和普通本地窗口双向同 thread 已通过；Remote SSH
回归、Windows x64 和生命周期门禁仍待补测。Bridge 不固定官方扩展版本号；系统
Codex CLI 仅作为可选外部客户端按能力探测，不固定版本，也不替代官方扩展内置运行时。
2026-07-18 的 `0.144.5` 组合仍是最近一次完成 Windows 主链路验收的支持基线；候选
自动化通过不等于发布支持。

| 组件 | 已探测版本 | 当前策略 | 状态 |
| --- | --- | --- | --- |
| VS Code | `1.130.0`（Linux x64 候选环境） | 扩展引擎最低 `^1.96.2` | 相对支持基线已变化；真实任务待补测 |
| 官方 Codex 扩展 | 本次实测 `openai.chatgpt@26.715.61943` | 固定扩展 ID，不固定版本；使用 VS Code 当前实际加载版本 | 插件内置运行时自动化、恢复会话、Remote SSH 新任务和本地窗口共享附着通过 |
| Bridge Controller | `0.3.1` Linux x64 候选；`0.2.7` 支持基线 | 同一扩展 ID，分别发布 `win32-x64` 和 `linux-x64` VSIX | `0.3.1` 网关级双向通知中继与去重、显式入口和普通 `codex` 自动入口已通过普通本地实机；Remote SSH 回归和 Windows 待补测 |
| Remote Executor | `0.2.7`，Linux x64 | Workspace 扩展；通过当前 Remote SSH 通道自动部署，不含 Codex 或凭据 | 精确版本与协议 v4 握手、远端构建摘要、主根探针通过；适配器和八工具证据继承自相同协议的 `0.2.6` 基线 |
| 官方扩展内置 Codex/app-server | `0.145.0-alpha.27` | 只从当前官方扩展安装目录启动；与生成协议精确匹配 | 线程/turn 远程根参数探针、协议门禁、真实 Shim、普通本地共享网关和本地附着通过；Remote SSH 官方 UI 回归待补测 |
| 系统 Codex CLI | 本次探针 `0.145.0`，不固定 | 仅用于 MCP、`resume --remote` 外部客户端和 POSIX 普通入口；运行时探测所需参数，官方扩展内置 app-server 仍是唯一服务端 | 普通 `codex` 可恢复接管、官方子命令透传和本地同 thread 实机通过；Remote SSH 和 Windows 待分别验证 |
| Remote SSH | `0.124.0` | 使用 `remote.extensionKind` 探针设置 | 版本未变；新兼容集合的固定远端探针待补测 |
| OpenSSH 客户端 | Linux `9.6p1`；Windows 支持基线 `9.5p2` | 严格主机校验、user/port/IdentityFile；ControlMaster 仅 Linux 启用 | 本次未触发 OpenSSH 回退实机链路 |

完整的升级触发条件、硬门禁、量化指标和分平台声明规则见
`docs/upgrade-tracking.md`。当前插件内置运行时候选证据见
`docs/acceptance/2026-07-22-release-0.2.7.md`，MCP 适配跟进证据见
`docs/acceptance/2026-07-22-release-0.2.7-mcp-adapter.md`，远程逻辑主根与逐轮路由见
`docs/acceptance/2026-07-22-release-0.2.7-remote-primary-root.md`；当前 CLI MCP 候选见
`docs/acceptance/2026-07-23-release-0.3.0-external-cli-mcp.md`，双向实时候选见
`docs/acceptance/2026-07-23-release-0.3.1-bidirectional-cli.md`；上一支持基线见
`docs/acceptance/2026-07-18-release-0.2.7.md`。

当前协议文件位于 `protocol/0.145.0-alpha.27/`。`ServerRequest.json` 的方法集合由自动化测试与
Shim 的已知请求白名单逐项比对；出现新请求时测试失败，而不是静默转发潜在副作用。
`ThreadStartParams`、`ThreadResumeParams` 和 `TurnStartParams` 固定远程逻辑主根与
逐轮应用上下文所依赖的字段；Remote SSH app-server 进程仍在本地控制目录启动。普通
本地窗口使用原始工作目录且不执行远程请求改写，仅共享 app-server 和外部附着网关。
0.2.0 另外使用该版本的 `commandExecution` 项、命令审批请求、输出增量字段，以及
`permissions=full-access`/`approvalPolicy=never` 权限语义，把 Bridge 工具投影成
官方原生外观并同步审批行为；MCP 路由器仅在 Remote SSH 窗口内扫描本机配置，并可
按窗口覆盖 MCP 的 `enabled`、`disabled_tools` 和 `default_tools_approval_mode`，
把无凭据且远端存在同名可执行文件的 stdio 服务按当前 Bridge 目标覆盖为远端启动；
默认模式复用 VS Code Remote 通道，OpenSSH 模式使用独立 SSH stdio 中转，
其他 MCP 和本地窗口仍使用用户原有配置。Controller 通过官方扩展 API 获取安装目录，
记录扩展版本并验证内置 Codex 协议后保存受限运行时指针；Shim 在启动 app-server 前
再次执行协议门禁。旧配置、PATH、`~/.local/bin` 和全局 npm 安装均不会改变运行时选择。
官方扩展升级时必须重新生成协议并重跑对应发布门禁。

Controller `0.3.x` 在 MCP override 中显式传递本地会话配置路径和受控适配器 ID，
relay 再从受限文件读取 IPC 端点和随机令牌；环境值不进入 app-server 参数或审计。
当前内置版本已在候选窗口完成真实 stdio MCP 初始化、八工具 `tools/list`、
`codegraph_status` 和 `remote_exec` 调用。

`openai.chatgpt@26.715.31925` 曾对本地 Extension Host 中的 Remote SSH 工作区 URI
返回 `Unknown local project`。当前 `26.715.61943` 只确认升级前旧会话可恢复，尚未证明
升级后新任务可创建。Bridge 不会通过伪造或改写 VS Code 工作区 URI 绕过项目校验；
必须重新执行任务创建与 Remote SSH 工作区加载验收。

## 升级步骤

1. 从 `docs/acceptance/release-template.md` 创建候选版本记录，填写全部组件版本、执行人、
   变更摘要和命中的升级触发项。
2. 保留旧 VSIX 和当前设置快照，记录升级前的 Shim、Executor 与官方设置状态。
3. 官方扩展更新时记录实测版本并重跑界面链路；只有其内置 Codex 版本或生成 Schema
   变化时才运行 `npm run protocol:generate`。脚本从最新安装的官方扩展生成协议并同步
   内置协议门禁；审查新增/删除服务端请求、动态工具字段和 MCP 启动行为。
4. 运行命中触发项的定向测试，再运行 `npm run check`，记录通过、失败、跳过和耗时。
5. 运行 `npm run package:all`，核对双平台包内版本、平台 Shim、嵌入 Executor、大小和
   SHA-256；清理 `dist/` 历史版本但保留当前产物。
6. 按本地平台分别执行 `docs/upgrade-tracking.md` 的分平台矩阵。没有 Linux 实机结果时
   必须写“Linux 打包通过、运行时待补测”。
7. 在隔离 Remote SSH 工作区重跑受影响的官方任务、远端操作、MCP、生命周期和安全
   失败链路，检查 Codex 日志与 Bridge 审计日志。
8. 采集量化指标；不足最低样本数的值只能作为参考，不能宣称无性能回归。
9. 更新本文件和 `docs/implementation-status.md`，在候选记录中给出支持范围、遗留风险
   和最终结论。

官方扩展缺失、身份错误或内置 app-server 协议不匹配时，Bridge 进入 `incompatible`，
不会尝试猜测字段或降级执行；仅插件版本号变化不会触发拒绝。
