# 升级多链路跟进指标

更新日期：2026-07-18

本文定义官方 Codex 扩展及其内置 app-server、Bridge Controller、Remote Executor、
VS Code/Remote SSH、OpenSSH 和 MCP 路由共同升级时的发布门禁、量化指标和证据格式。
`docs/compatibility.md` 只保存当前支持组合；每次候选版本的实测结果必须另存到
`docs/acceptance/`，不能用新的兼容矩阵覆盖旧证据。

## 1. 记录规则

- 每次 Bridge 发布，或兼容集合中任一组件版本变化时，复制
  `docs/acceptance/release-template.md` 创建
  `docs/acceptance/YYYY-MM-DD-release-<bridge-version>.md`。
- 状态只使用 `通过`、`失败`、`待补测`、`不适用`。没有采集的数据写 `待补测`，不得
  写成 `0`、`正常` 或沿用旧版本结果。
- 每条结论必须包含执行平台、执行日期和证据位置。人工实机项还要记录执行人或
  `用户手动操作 + Codex 复核`，不能只写“已验证”。
- Windows x64 和 Linux x64 的 Controller 运行结果分开记录。在 Windows 构建机生成
  `linux-x64` VSIX 只能证明打包和内容隔离，不能代替 Linux 本地 Extension Host、
  Linux Shim 和官方扩展的运行时验收。
- 硬门禁任一失败时不得把新组合写成“支持”。`待补测` 不等于失败，但必须限制声明
  范围，例如只声明“Linux 包已生成”，不能声明“Linux 运行链路已验证”。
- 证据不得包含密码、私钥、Token、完整环境变量或会话 transport token。

## 2. 升级触发矩阵

| 变化源 | 最小重跑范围 | 重点证据 |
| --- | --- | --- |
| 官方 `openai.chatgpt` 扩展 | 官方面板加载、Remote SSH 工作区加载、任务创建、任务到达 Shim、审批、会话继续、本地窗口透传 | 扩展版本、Codex 日志、Bridge 日志、任务结果 |
| 官方扩展内置 app-server | 协议重新生成和差异审查、协议兼容测试、`initialize`、`thread/list`、`thread/start`、`thread/resume`、动态工具、MCP 配置覆盖；不固定官方扩展版本 | 来源扩展版本、`protocol/<version>/`、测试输出、Shim 冒烟输出 |
| Bridge Controller 或 Shim | `npm run check`、双平台打包、旧 Shim 迁移、设置备份/恢复、本地窗口隔离、真实 Remote SSH 主链路 | 构建日志、VSIX 清单、Controller 日志、审计日志 |
| Remote Executor 或协议版本 | 内嵌 VSIX 一致性、自动安装/升级、ping 协议、工作区根校验、远端读/搜/Git/命令、stdio 生命周期 | Executor 版本、协议号、诊断、远端操作审计 |
| VS Code 或 Remote SSH 扩展 | UI/Workspace Extension Host 放置、窗口重载、`ready`、当前工作区 URI、现有认证复用、断线行为 | `code --status` 摘要、双方日志、诊断报告 |
| OpenSSH 客户端或 `openssh` 路径 | 可执行文件发现、严格主机校验、参数边界、真实连接；Linux 额外检查 ControlMaster 清理 | 参数测试、真实 SSH 验收、清理记录 |
| MCP 配置、Codex MCP 层或 relay | 本机服务筛选、本地服务保持、远端可执行文件探针、`initialize`、`tools/list`、真实 `tools/call`、relay/窗口关闭清理 | `shim.start` 路由摘要、Codex 日志、真实工具结果、进程清理记录 |
| 安全策略、路径或审批 | 本地回退为零、路径/符号链接逃逸拒绝、未知请求拒绝、审批绑定、敏感信息扫描 | 失败用例、审计日志、脱敏检查 |

一次变更命中多行时取并集，不能只选择最短链路。例如 Codex CLI 升级同时改变 MCP
启动环境时，必须同时重跑 app-server、MCP 和真实 Remote SSH 三条链路。

## 3. 发布硬门禁

| 编号 | 链路 | 通过条件 |
| --- | --- | --- |
| G0 | 版本与协议 | 记录全部组件版本；本地 Codex 与 `codexAppServerVersion` 精确匹配；Executor ping 返回当前协议版本；不匹配时进入 `incompatible` |
| G1 | 自动化 | 定向测试通过；`npm run check` 零失败；发布前 `npm run package:all` 成功；所有跳过项记录原因 |
| G2 | 产物 | 当前 Controller 的 Windows/Linux VSIX、当前版本 Executor VSIX 和无版本嵌入副本均存在；包内版本正确；Windows 只含 `.exe` Shim，Linux 只含 `.cjs` Shim；记录大小和 SHA-256 |
| G3 | 官方界面/App Server | 支持平台上官方面板可加载并创建任务；任务到达当前 Shim；`initialize`、线程列表和线程创建成功；普通本地窗口不被 Bridge 接管 |
| G4 | Remote SSH 执行 | Controller 到达 `ready`；诊断证明 Codex 在本地、Executor 和项目操作在远端；固定探针至少覆盖读取、目录树、搜索、`git status` 和 `pwd`；审计中的本地项目操作数为零 |
| G5 | stdio MCP | 远端候选服务出现在 `remoteMcpServers`；不合格服务保持本机；Codex Core 完成 `initialize`、`tools/list` 和至少一次真实 `tools/call`；默认模式不建立第二条 SSH 认证链路 |
| G6 | 生命周期 | 旧 Shim/Executor 能迁移到当前版本；首次必要重载后恢复 `ready`；停止、relay 断开或窗口关闭后遗留 relay/MCP 子进程为零；设置恢复结果与升级前快照一致 |
| G7 | 安全失败 | 敏感信息命中数、错误本地回退数、错误远端 Codex 进程数均为零；路径逃逸和未知副作用请求被拒绝；断线不自动重放非幂等操作 |
| G8 | 双平台 | Windows 和 Linux 分别记录构建、Shim 冒烟、包内容及真实运行状态；未执行的平台保持 `待补测`，不得由另一平台结果推断 |
| G9 | 证据闭环 | 发布记录包含触发项、门禁、量化指标、平台矩阵、产物哈希、证据链接、遗留风险和最终声明范围 |

尚未实现的产品能力，例如哈希保护写入、运行中取消和断线恢复，使用 `不适用` 并链接
`docs/implementation-status.md`；只有该版本开始声明能力时，相关门禁才必须转为
`通过`。安全硬门禁 G7 不能因功能未实现而省略。

## 4. 量化指标

### 4.1 采样与回归规则

- 自动化测试和固定探针记录每次运行的成功、失败和跳过数量。
- 延迟类指标在同一平台、同一目标上至少采集 3 次，记录样本数、P50 和最大值。只有
  1 次历史样本时可以建立参考值，但不能据此宣称性能稳定。
- 与上一份同平台、同链路的成功基线比较。P50 同时超过上一版的 `1.5 倍` 和
  `上一版 + 5 秒` 时标记性能回归；发布记录必须解释或阻塞发布。
- 固定探针成功率、错误本地回退、远端 Codex、敏感信息和遗留进程属于硬指标，不使用
  性能容差。
- VSIX 大小相对上一版变化超过 20% 时必须解释；SHA-256 只用于产物身份，不要求跨次
  构建保持相同。

### 4.2 必填指标

| 指标 | 定义 | 最低样本 | 门槛 |
| --- | --- | --- | --- |
| 自动化结果 | `npm run check` 的测试文件、通过/失败/跳过测试数及总耗时 | 1 次 | 失败为 0；跳过有原因 |
| 双平台打包 | `npm run package:all` 结果、耗时和产物数 | 1 次 | 4 个当前发布/嵌入 VSIX 均存在 |
| 冷启动到 `ready` | `configuring` 首条日志到首次 `ready` 的时间 | 3 次 | 3/3 成功；按回归规则比较 |
| 热启动到 `ready` | 已配置窗口启动到首次 `ready` 的时间 | 3 次 | 3/3 成功；按回归规则比较 |
| 官方任务创建 | 用户提交任务到 `shim.start`/线程创建成功的时间 | 3 次 | 3/3 成功；无 `Unknown local project` |
| 固定远端探针 | 读取、目录树、搜索、Git、`pwd` 各自的成功数和审计 `durationMs` | 每项至少 5 次 | 成功率 100%；P50 按回归规则比较 |
| MCP 初始化 | relay 启动到 `tools/list` 返回目标工具的时间 | 3 次 | 3/3 成功 |
| MCP 工具调用 | 固定查询的成功数、P50、最大值和 `isError` | 至少 5 次 | 成功率 100%，`isError=false` |
| 额外认证 | `vscode-remote` 模式中新建 OpenSSH/密码提示次数 | 1 个完整会话 | 0 |
| 错误执行位置 | 本地项目文件/Shell/Git/测试操作数 | 1 个完整会话 | 0 |
| 远端 Codex | 远端 `codex`/app-server 进程数和 `remote.codexInstalled` | 1 个完整会话 | 0 / `false` |
| 遗留进程 | 停止、relay 断开和窗口关闭后的 Bridge relay/MCP 子进程数 | 每种关闭方式 1 次 | 0 |
| 敏感信息 | 提交的日志和验收材料中 Token、私钥、会话令牌命中数 | 1 次扫描 | 0 |
| 设置恢复 | 升级前后 `chatgpt.cliExecutable` 与 `remote.extensionKind` 快照差异 | 1 次 | 恢复后差异为 0 |
| 产物身份 | 每个保留 VSIX 的字节数、SHA-256、包内版本和平台 Shim | 每个产物 1 次 | 与当前版本和目标平台一致 |

对于尚未实现的取消、断线恢复、写入哈希和幂等能力，发布记录必须继续列出
`不适用（能力未实现）`。开始实现后追加取消确认耗时、断线检测耗时、重复副作用数和
写入冲突拒绝率，不能复用只读链路结果。

## 5. 分平台覆盖矩阵

每个候选版本至少填写下表。`包内容` 与 `真实运行` 是两个不同结论。

| 本地平台 | 构建/类型检查 | Shim 冒烟 | 包内容 | 官方任务 | Remote SSH 操作 | stdio MCP | 设置恢复 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows x64 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 |
| Linux x64 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 | 待补测 |

远端 Ubuntu Executor 的验收另记在平台行的证据中。Windows Controller 连接远端 Ubuntu
只能证明 Windows 本地主链路和 Linux Workspace Executor，不能证明 Linux Controller。

## 6. 证据来源

- `npm run check`、`npm run package:all` 和定向测试的完整退出状态。
- VSIX 文件清单、包内 `extension/package.json`、字节数和 SHA-256。
- `Codex Bridge: Run Diagnostics` 的脱敏结果。
- 官方 Codex 日志、Codex Remote Bridge 输出通道和本地 Bridge 审计日志的相关摘要。
- 远端身份、进程、Git/文件哈希及固定探针结果；不得提交敏感项目内容。
- 对于实机操作，记录窗口重载、任务创建、审批、断开和恢复的人工步骤及结果。

最新基线见 `docs/acceptance/2026-07-18-release-0.2.7.md`。
当前官方扩展内置运行时候选及未通过门禁见
`docs/acceptance/2026-07-22-release-0.2.7.md`。
