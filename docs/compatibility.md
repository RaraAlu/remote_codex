# 兼容矩阵

更新日期：2026-07-18

| 组件 | 已探测版本 | 当前策略 | 状态 |
| --- | --- | --- | --- |
| VS Code | `1.129.1`（Windows x64） | 扩展引擎最低 `^1.96.2` | 本机构建通过 |
| 官方 Codex 扩展 | `openai.chatgpt@26.715.31925` | 全局 Shim，本地 Extension Host，按窗口会话激活 | Remote SSH 接管与本地窗口透传已并行验证 |
| Bridge Controller | `0.2.5`，Windows x64、Linux x64 | 同一扩展 ID，分别发布 `win32-x64` 和 `linux-x64` VSIX | 两个目标包均已生成并检查内容 |
| Remote Executor | `0.2.4`，Linux x64 | Workspace 扩展；通过当前 Remote SSH 通道自动部署，不含 Codex 或凭据 | 真实 Remote SSH 窗口已通过握手、探针、`pwd` 和目录读取回环 |
| Codex CLI/app-server | `0.144.5` | 必须与生成协议精确匹配；按平台发现原生可执行文件 | Windows 原生 npm CLI 的版本、`initialize`、`thread/list` 和 `thread/start` 冒烟通过 |
| Remote SSH | `0.124.0` | 使用 `remote.extensionKind` 探针设置 | 待真实窗口验收 |
| OpenSSH 客户端 | Windows `9.5p2`；Linux 已验 `9.6p1` | 严格主机校验、user/port/IdentityFile；ControlMaster 仅 Linux 启用 | Windows 可执行文件发现和参数测试通过；Linux xj-member 真实连接通过 |

协议文件位于 `protocol/0.144.5/`。`ServerRequest.json` 的方法集合由自动化测试与
Shim 的已知请求白名单逐项比对；出现新请求时测试失败，而不是静默转发潜在副作用。
0.2.0 另外使用该版本的 `commandExecution` 项、命令审批请求、输出增量字段，以及
`permissions=full-access`/`approvalPolicy=never` 权限语义，把 Bridge 工具投影成
官方原生外观并同步审批行为；MCP 路由器仅在 Remote SSH 窗口内扫描本机配置，并可
按窗口覆盖 MCP 的 `enabled`、`disabled_tools` 和 `default_tools_approval_mode`，
把无凭据且远端存在同名可执行文件的 stdio 服务按当前 Bridge 目标覆盖为 SSH 启动，
其他 MCP 和本地窗口仍使用用户原有配置。当前官方扩展内置的 `0.145.0-alpha.18`
不会被 0.2.0 选作 Bridge 后端；必须安装或指定精确的 `0.144.5`。升级 app-server 时
这些字段必须一并复核。

## 升级步骤

1. 保留旧 VSIX 和当前设置备份。
2. 更新本地 Codex 后运行 `npm run protocol:generate`。
3. 审查生成协议中的新增/删除服务端请求和动态工具字段。
4. 显式更新兼容代码和本文件，不能只修改版本号。
5. 运行 `npm run check`。
6. 在隔离 Remote SSH 工作区重新执行阶段 A/B 验收。

官方扩展或 app-server 版本不匹配时，Bridge 进入 `incompatible`，不会尝试猜测字段或
降级执行。
