# 兼容矩阵

更新日期：2026-07-22

当前源码是 Codex `0.145.0` 候选，尚未完成官方扩展新任务和真实 Remote SSH 门禁。
2026-07-18 的 `0.144.5` 组合仍是最近一次完成 Windows 主链路验收的支持基线；候选
自动化通过不等于发布支持。

| 组件 | 已探测版本 | 当前策略 | 状态 |
| --- | --- | --- | --- |
| VS Code | `1.130.0`（Linux x64 候选环境） | 扩展引擎最低 `^1.96.2` | 相对支持基线已变化；真实任务待补测 |
| 官方 Codex 扩展 | `openai.chatgpt@26.715.61943` | 全局 Shim，本地 Extension Host，按窗口会话激活 | Shim 启动和旧会话恢复有升级前证据；升级后新任务待补测 |
| Bridge Controller | `0.2.7`，Windows x64、Linux x64 | 同一扩展 ID，分别发布 `win32-x64` 和 `linux-x64` VSIX | Linux 自动化、Shim 冒烟、候选安装和包内容通过；真实 Remote SSH 待补测 |
| Remote Executor | `0.2.5`，Linux x64 | Workspace 扩展；通过当前 Remote SSH 通道自动部署，不含 Codex 或凭据 | 协议 v3 的握手、通用 stdio MCP 初始化、工具枚举和真实工具调用通过 |
| Codex CLI/app-server | `0.145.0` | 必须与生成协议精确匹配；按平台发现原生可执行文件 | Linux 原生 npm CLI、协议测试和真实 app-server Shim 冒烟通过；官方任务待补测 |
| Remote SSH | `0.124.0` | 使用 `remote.extensionKind` 探针设置 | 版本未变；新兼容集合的固定远端探针待补测 |
| OpenSSH 客户端 | Linux `9.6p1`；Windows 支持基线 `9.5p2` | 严格主机校验、user/port/IdentityFile；ControlMaster 仅 Linux 启用 | 本次未触发 OpenSSH 回退实机链路 |

完整的升级触发条件、硬门禁、量化指标和分平台声明规则见
`docs/upgrade-tracking.md`。Codex `0.145.0` 候选证据见
`docs/acceptance/2026-07-22-release-0.2.7.md`；上一支持基线见
`docs/acceptance/2026-07-18-release-0.2.7.md`。

当前协议文件位于 `protocol/0.145.0/`。`ServerRequest.json` 的方法集合由自动化测试与
Shim 的已知请求白名单逐项比对；出现新请求时测试失败，而不是静默转发潜在副作用。
0.2.0 另外使用该版本的 `commandExecution` 项、命令审批请求、输出增量字段，以及
`permissions=full-access`/`approvalPolicy=never` 权限语义，把 Bridge 工具投影成
官方原生外观并同步审批行为；MCP 路由器仅在 Remote SSH 窗口内扫描本机配置，并可
按窗口覆盖 MCP 的 `enabled`、`disabled_tools` 和 `default_tools_approval_mode`，
把无凭据且远端存在同名可执行文件的 stdio 服务按当前 Bridge 目标覆盖为远端启动；
默认模式复用 VS Code Remote 通道，OpenSSH 模式使用独立 SSH stdio 中转，
其他 MCP 和本地窗口仍使用用户原有配置。当前官方扩展内置的
`0.145.0-alpha.27` 不满足精确版本要求；Controller 使用 `~/.local` 中已安装的稳定版
`0.145.0`。升级 app-server 时这些字段必须一并复核。

Controller `0.2.7` 在 MCP override 中显式传递本地会话配置路径，relay 再从受限文件
读取 IPC 端点和随机令牌；这兼容已验证的 `0.144.5` 环境变量清理行为。`0.145.0` 的
真实 stdio MCP 初始化、`tools/list` 和工具调用仍需在候选窗口重跑。

`openai.chatgpt@26.715.31925` 曾对本地 Extension Host 中的 Remote SSH 工作区 URI
返回 `Unknown local project`。当前 `26.715.61943` 只确认升级前旧会话可恢复，尚未证明
升级后新任务可创建。Bridge 不会通过伪造或改写 VS Code 工作区 URI 绕过项目校验；
必须重新执行任务创建与 Remote SSH 工作区加载验收。

## 升级步骤

1. 从 `docs/acceptance/release-template.md` 创建候选版本记录，填写全部组件版本、执行人、
   变更摘要和命中的升级触发项。
2. 保留旧 VSIX 和当前设置快照，记录升级前的 Shim、Executor 与官方设置状态。
3. Codex 版本变化时运行 `npm run protocol:generate`，审查新增/删除服务端请求、动态
   工具字段和 MCP 启动行为；不能只修改版本号。
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

官方扩展或 app-server 版本不匹配时，Bridge 进入 `incompatible`，不会尝试猜测字段或
降级执行。
