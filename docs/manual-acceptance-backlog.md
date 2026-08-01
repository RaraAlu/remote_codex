# 统一人工补测清单

更新日期：2026-08-02

## 执行约定

本文收集无法由自动化、静态包核对或本机构造替代的人工/实机证据。2026-07-27 用户
决定关闭剩余 Linux 补测并停止本轮 `0.4.0` 发布；已关闭但未执行的项目不计为通过，
也不补写量化结果。后续只在 Windows x64 环境准备好后恢复对应原生验证和双平台发布
门禁。

- Linux x64 Controller、Linux Shim、远端 Ubuntu Executor 和 `g1_1` 的 VS Code
  Remote SSH 补测已经收束；剩余 L04-L07 项按用户决定关闭，不再作为活动清单。
- Windows x64 是下一次发布决策前唯一保留的实机前置；不得由 Linux 结果推断。
- OpenSSH 是 Linux 上的可选回退链路，只有用户后续显式选择 `openssh` 才进入本轮
  实测；在此之前继续复用活动 VS Code Remote transport。
- 不为中间开发版本反复安装 VSIX；统一安装最终候选。
- 新建 Remote SSH 连接、窗口重载和官方 UI 操作由用户执行；当前已认证窗口优先复用，
  不启动第二条 SSH 认证链路。
- Windows x64 与 Linux x64 分开记录，构包结果不得替代对应平台运行时。
- 每项必须保存脱敏后的 Codex 日志、Bridge 输出、审计摘要和量化结果。
- 不记录密码、私钥、Token、完整环境变量或 transport 会话令牌。

## 已积累证据（不替代完整门禁）

`docs/acceptance/2026-07-26-release-0.3.26-fresh-conversation.md` 已记录 Zklab 的前期
样本，以及最终 `0.3.26` 在 `g1_1` 的新 thread、后台任务和远端 CodeGraph 样本；
`docs/acceptance/2026-07-26-release-0.3.28-lifecycle-cleanup.md` 继续记录 Executor
`0.2.15` 和 Controller/Shim `0.3.28` 的窗口重载生命周期修复；
`docs/acceptance/2026-07-26-release-0.3.29-explicit-stop.md` 记录 Executor `0.2.16`
和 Controller/Shim `0.3.29` 的显式停止、设置恢复及重新启用；
`docs/acceptance/2026-07-26-release-0.3.30-external-disconnect.md` 记录
Controller/Shim `0.3.30` 的外部 CLI 中途断连自动中断及运行中远端进程清理；
`docs/acceptance/2026-07-26-release-0.3.30-injectable-matrix.md` 继续记录审批、写入
失败、Core 本地阻断、同 thread 双向观测、托管 CLI 和安全复扫；
`docs/acceptance/2026-07-26-release-0.3.30-manual-linux.md` 记录当前候选的冷/热启动
以及官方面板直接新建和恢复样本；
`docs/acceptance/2026-07-26-release-0.3.31-local-root-picker.md` 记录 Remote SSH
窗口中的本地选择器修复、当前版本热启动，以及 L02 的授权、双根读写、失败关闭、撤销
和重新授权闭环；
`docs/acceptance/2026-07-26-release-0.3.32-remote-editor-context.md` 记录官方附件对
Remote SSH URI 的能力缺口、自动远端 IDE 选区/完整文件、本地次级根隔离和最终候选
官方面板直接任务；`docs/acceptance/2026-07-26-release-0.3.33-local-full-access.md`
记录普通本地外部 `full-access` 消息修复及精确候选的本地/Remote SSH 回归；
`docs/acceptance/2026-07-26-release-0.3.34-transport-close.md` 记录活动 transport
socket 关闭挂起修复、写入失败完整性和固定探针；
`docs/acceptance/2026-07-27-release-0.3.37-executor-loss-response.md` 记录
Executor 独立失联响应修复和精确候选复测；
`docs/acceptance/2026-07-27-release-0.3.39-official-task-samples.md` 记录精确
`0.3.39` 官方面板直接新建和恢复各 3/3 的任务、路由和日志证据；
`docs/acceptance/2026-07-27-release-0.3.42-permission-mode-presentation.md` 记录
官方权限选择器与内部本地拒绝档案的隔离修复及连续切换实机结果；
`docs/acceptance/2026-07-27-release-0.3.43-plain-cli-workspace-selection.md` 记录普通
`codex` 跨工作区误判修复、已安装 Shim 故障条件注入和本地真实 TUI 结果。
下面按 Linux 子链保留已完成证据和关闭决定；Windows x64 继续保持未验证，未选择的
OpenSSH 和已关闭的故障矩阵不得由既有 Linux 子链推断为通过。

- M01：精确 `0.3.37` Linux VSIX 已安装、重载并恢复 `ready`，活动 Shim 来自
  `0.3.37-efb8ea7d5b649882`，Executor 已按实际能力升级为 `0.2.19`；
  三次 `configuring` 到 `ready` 为 4,354 ms、3,999 ms、3,871 ms，当前热启动
  3/3，P50 为 3,999 ms、最大值为 4,354 ms、失败数为 0。
  三次关闭并重新打开 Remote SSH 窗口后的冷启动为 4,269 ms、4,010 ms、4,396 ms，
  当前冷启动 3/3，P50 为 4,269 ms、最大值为 4,396 ms、失败数为 0；三轮旧 Shim
  进程和旧会话描述符均已消失。
  当前候选外部 MCP 注入新建和恢复各完成 3/3：新建 turn 为 19,934 ms、7,571 ms、
  8,734 ms，恢复为 9,415 ms、7,793 ms、6,147 ms；6 次均进入当前 Shim，并在
  `remote-primary` 的规范远端根执行。该结果不替代官方面板对
  `Unknown local project` 的 UI 门禁。
  `0.3.31` 候选热启动
  3/3 通过，P50 为 3,619 ms、
  最大值为 3,927 ms；
  `0.3.30` 曾完成冷启动 2/3、官方 UI 直接新建和恢复各 3/3。Controller 已更新到
  `0.3.37`；`0.3.34` 精确产物热启动 1 次为 3,812 ms。`0.3.37` 已完成三次
  重载并以 4,354 ms、3,999 ms、3,871 ms 恢复 `ready`，当前热启动 3/3，
  P50 为 3,999 ms。`0.3.32`
  最终精确产物的官方 UI
  直接新建 1 次为 84 ms 创建、5,984 ms 完成，自动选区正确。当前候选冷/热启动、
  注入新建/恢复和精确 `0.3.39` 官方面板直接新建/恢复最低样本均已完成。
- M02：`0.3.30` 实机注入的 `fs/readFile`、`command/exec`、`thread/shellCommand`
  和未知 `fs/` 风险方法均返回 `-32003` 并进入失败审计；成功本地项目操作为 0。
  `0.3.32` 已绕过官方附件只接受 `file:` URI 的限制，每轮自动采集真实远端选区或
  完整文件；最终官方 UI 直接任务、本地次级根虚拟资源隔离均通过。同名 Bridge 工具
  诱饵的 9 个远端项目操作成功，本地项目操作为 0，远端文件恢复初始哈希。本地 Core
  `0.3.33` Remote SSH task 又实际发起 5 次 Core 本地读取、Git 和写入尝试，均在
  受限 sandbox 启动阶段失败；本地诱饵哈希不变、临时文件为 0，随后远端同名文件与
  `pwd` 成功。`0.3.33` 也已修复本地外部 `full-access` 消息兼容缺口，精确候选完成
  真实本地文件读取和 Git 命令；两种窗口策略没有互相污染。
- M03：`g1_1` 的远端读取、目录树、搜索和 `pwd` 各 5 次全部成功并记录 P50/最大值；
  在不覆盖既有 `.git` 的隔离前置条件下，远端 `workspace_git_status` 也达到 5/5，
  P50 为 81 ms、最大值为 93 ms，清理后主根恢复为非 Git 状态。`0.3.31` 已完成本地
  次级根选择、两次重载持久化、同 thread 双端交替、旧/新请求撤销失败关闭及重新授权
  恢复；L02 已收口。`0.3.34` 历史精确候选重新采集读取、目录树、有效查询搜索、Git 和
  `pwd` 各 5/5；各自 P50 为 130、118、98、91、77 ms，最大值为
  133、123、100、117、84 ms，隔离 Git 元数据再次完成清理。
- M04：`g1_1` 的远端目录创建、文件写入、精确补丁、重命名和清理闭环通过；过期哈希
  5/5 返回 `FILE_CONFLICT` 且原文件不变；重命名目标已存在和临时权限拒绝也失败关闭
  并完成恢复清理。`0.3.30` 又确认多替换中的部分失败保持原文件不变，1,048,577 字节
  文件以 `OUTPUT_TRUNCATED` 拒绝补丁且哈希不变；1 MiB 文件补丁刚进入执行即断开外部
  CLI 后，turn 自动中断且文件仍为原哈希、临时文件为 0。`0.3.31` 又完成本地/远端
  交替写入、补丁、重命名、删除，以及本地部分失败、过期哈希、权限和 1 MiB 上限矩阵。
  `0.3.34` 又用原始 1,048,577 字节写入验证 1 MiB 上限，并在写入请求已发送后关闭
  活动 transport socket；分别得到 `OUTPUT_TRUNCATED` 和 `RESULT_UNKNOWN`，原哈希
  均不变且临时文件为 0。独立失联探针随后在远端写入临时文件出现时终止 Extension
  Host：进程自动换 PID且临时文件为 0，但短 stdin 被当作正常 EOF，目标被部分新内容
  替换，调用方还误收可重试 `REMOTE_TRANSPORT_DISCONNECTED`；`0.3.36` 已增加声明
  字节数校验、实际能力部署门槛并修复错误语义，原文件和结果通过，但 SIGKILL 后仍
  观察到 1 个临时文件。`0.3.37` 增加死亡拥有者登记清理；精确候选故障注入使
  Extension Host 从 PID `52431` 切换为 `56533`，返回不可重试 `RESULT_UNKNOWN`，
  原文件哈希与大小不变，临时文件、登记和观察进程均为 0。审计只有一次
  started/unknown，后置探针确认无残留或重放。
- M05：真实远端文件打开返回当前 `g1_1` Remote SSH URI，Diff 的错误快照
  `FILE_CONFLICT` 和正确快照成功路径均通过；文件焦点、选区、左右端及同名文件视觉
  呈现仍待人工确认。
- M06：附着 CLI 方向运行中取消达到 3 次并确认目标进程消失；`on-request` 命令审批
  拒绝时没有启动进程。`0.3.30` 的外部 CLI 审批接受后命令成功；审批等待中取消记录
  `cancelledCalls=1`、工具 `CANCELLED` 且远端进程为 0。官方 UI 方向仍待补。
- M07：响应丢失代理下 completed、failed、cancelled、running、unknown 各达到至少
  5 次，首次状态查询丢失也可恢复；同键 5 次只执行一次，同键改参 5/5 拒绝。账本
  重启后查询两个旧前台键和一个旧后台任务均返回 `unknown` 且没有重发；当前
  Executor 的已完成结果等待 905 秒后也从 `completed` 变为 `unknown` 且没有重发。
  精确 `0.3.37` Executor 独立失联又确认查询 3 次仍不可达时返回
  `RESULT_UNKNOWN`，原写入不重放且文件完整。
- M08：`g1_1` 已覆盖后台成功、失败、超时、4 MiB 日志截断、客户端断开后继续、
  幂等/改参冲突和运行中取消；`0.3.28` 重载样本确认 Extension Host 退出后前台和
  后台标记进程均为 0。`0.3.29` 显式停止和设置恢复各清理 1 个后台任务，停止后状态
  为 `unknown` 且没有重发。Remote SSH 窗口关闭仍待补。
- M09：`g1_1` 启动审计为 `remoteMcpServers=["codegraph"]`；真实 VS Code transport
  relay 的 `initialize`/`tools/list` 各 3 次、固定 `codegraph_status` 6 次均通过。
  `enabled` 模式只暴露默认的 `codegraph_explore`，`all` 模式通过
  `codegraph-all-tools-v1` 暴露 8 个工具，启动参数和当前进程级审批覆盖均与设置一致。
  Executor `0.2.15` 主动停止、relay 断开和 `0.3.28` Extension Host 重载均确认
  两层 CodeGraph 进程与本地测试 relay 为 0。`0.3.29` 显式停止和设置恢复又分别清理
  1 个远端 stdio 会话及本地 relay，遗留均为 0。精确 `0.3.49` 重载后又完成一次
  直接 Codegraph MCP `codegraph_status`：`29 ms` 返回远端项目 93 个索引文件；同一
  turn 的 `remote_exec(["pwd"])` 在省略 `target/rootId` 时以 `19 ms` 返回远端主根，
  两条路径均由当前 VS Code Remote transport 和远端进程确认。窗口关闭矩阵仍待补。
- M10：外部 MCP 方向完成新 thread、steer、3 次取消、历史观察、安全写入和
  `expectedTurnId` 冲突拒绝；官方 UI 反向操作、断开、重启、描述符过期和权限撤销
  中，重载后的旧端点已确认 `ECONNREFUSED`，旧 Token 访问当前网关返回 401，当前
  Token 正常连接。`0.3.29` 已复现 CLI 断开后 turn 永久 `inProgress`，`0.3.30`
  两次实机样本均自动变为 `interrupted`，中断确认 1/1；其中 120 秒远端标记进程在
  断开后立即为 0。当前版本的 CLI steer 保持同一 turn ID，35 条通知转发到 VS Code，
  精确重复帧为 0；`codex-vscode` 真实 TUI 恢复和退出通过。原先普通 `codex` 会把
  其他工作区的多个活动会话误判为当前目录歧义；`0.3.43` 已改为无目录匹配时透传官方
  CLI，并用已安装 Shim 注入两个存活的其他工作区 thread 复核。官方 UI 反向操作、
  单会话同目录自动附着和权限撤销仍维持此前关闭决定。
  Windows `0.3.58` 又完成显式 `codex-vscode.exe` 历史 thread 恢复和无 rollout
  冷启动降级。冷样本首个 initialize 在 `30,011 ms` 超时后立即关闭，重试为 `1 ms`，
  resume 明确失败为 `73 ms`，随后同步新 thread 为 `94 ms`；单次命令进入 TUI，退出
  清理完成。Windows `0.3.59` 随后完成普通 `codex` 同名入口：唯一同目录任务自动进入
  TUI，无匹配目录透传官方 CLI；PowerShell/CMD 参数透传、歧义失败关闭自动化、停用后
  三个 npm wrapper 精确恢复、重新启用，以及真实 npm 同版本重装后的自动修复均通过。
- M11：活动 Token 对审计、Code 日志、Git 跟踪文件和本地进程参数的精确泄漏扫描为
  0，私钥/Bearer/`sk-` 形式命中为 0；远端 Codex/app-server 和测试探针进程均为 0，
  成功本地项目操作为 0。`0.3.26 -> 0.3.28` 迁移中 Executor 按能力自动升级到
  `0.2.15`；重载后旧 Extension Host、relay、MCP、前后台任务、会话文件和 socket
  均清理。`0.3.28` 又对 467 个 Code 日志、212 个 Git 跟踪文件和 670 个进程参数
  重跑活动 Token 与密钥形式扫描，命中仍为 0；远端敏感环境键、Codex/app-server
  和标记进程也为 0。`0.3.29` 显式停止清理后台 1、操作 4、stdio 1；设置恢复驱动
  停止清理后台 1、操作 3、stdio 1，托管设置恢复到升级前快照且差异为 0，重新启用
  后当前 Shim 任务和远端 `pwd` 通过。`0.3.30` 又确认外部 CLI 断连后 turn 自动
  中断、运行中远端进程归零且无命令重放；3 个活动令牌样本对审计、588 个 Code
  日志、212 个 Git 文件、701 个进程参数和 MCP 配置的命中均为 0，远端测试路径、
  Codex/app-server、标记进程和敏感环境键也均为 0。Remote SSH 窗口关闭仍待补。
- Linux 本地 Controller 已安装并在 `g1_1` 重载为精确 `0.3.49` 候选，Executor
  保持 `0.2.19`；当前自包含 Shim、app-server initialize 心跳、等待态到 `ready`、
  官方新 turn、远端 `pwd` 和直接 Codegraph MCP 已闭环，证据见
  `docs/acceptance/2026-07-28-release-0.3.49-linux-startup-real.md`。
  中断工具即时终态和跨 turn 有界历史恢复均已完成实机复核，
  `0.3.37` 的精确安装、重载、能力升级和独立失联写入已经闭环。L02、自动 IDE
  背景、外部 `full-access` 和 transport socket 关闭挂起修复均已闭环。精确
  `0.3.39` 官方 UI 直接新建和恢复也已各完成 3/3，失败数和
  `Unknown local project` 均为 0。`0.3.42` 已确认权限列表只包含三个官方内置
  档案，连续切换不再显示内部 `codex-remote-bridge`。

## 当前 Linux 剩余人工批次

以下保留 Linux 候选无法由注入、协议探针或静态检查替代的人工动作及已完成证据。
每次用户完成动作后，Codex 负责读取日志、审计、会话和远端进程，执行其余工具矩阵并
更新证据。Windows x64 和未选择的 OpenSSH 回退不在本轮。

### L01 当前候选启动与官方任务样本

- 当前证据：精确 `0.3.49` 在用户重载 `g1_1` 后用 `3,615 ms` 从 `connecting`
  到达 `ready`；期间先进入 `degraded`，在当前 Shim 的 app-server initialize 后
  `250 ms` 才转为 `ready`。自包含 ELF Shim 不依赖 Node，官方新 turn 在
  `13,935 ms` 内完成远端 `pwd` 和直接 Codegraph MCP 状态调用，失败数为 0。
- 当前证据：精确 `0.3.37` 三次重载分别在 4,354 ms、3,999 ms、3,871 ms 从
  `configuring` 到达 `ready`，当前热启动 3/3，P50 为 3,999 ms、最大值为
  4,354 ms、失败数为 0；活动 Shim 和 Executor 摘要均与最终构建一致。
- 当前证据：三次关闭并重新打开 `g1_1` Remote SSH 窗口后，冷启动分别在
  4,269 ms、4,010 ms、4,396 ms 到达 `ready`，P50 为 4,269 ms、最大值为
  4,396 ms、失败数为 0；旧 Shim PID `1420089`、`1423427`、`1425979` 和对应旧
  会话描述符均已清理，新 Shim 与 Executor 摘要不变，当前冷启动 3/3。
- 当前证据：外部 MCP 注入新建和恢复各完成 3/3。新建 turn 为 19,934 ms、
  7,571 ms、8,734 ms，P50 为 8,734 ms、最大值为 19,934 ms；恢复为 9,415 ms、
  7,793 ms、6,147 ms，P50 为 7,793 ms、最大值为 9,415 ms；失败数均为 0。
  6 次审计均为 `clientSource=external-mcp`、`target=remote`、
  `rootId=remote-primary`，远端根和 `remoteCwd` 都是
  `/home/unitree/mimiclite-sim2real`。
- 当前证据：精确 `0.3.39` 官方面板直接新建和恢复各完成 3/3。新建 conversation
  创建耗时为 1,581 ms、1,678 ms、83 ms，P50 为 1,581 ms、最大值为
  1,678 ms；新建 turn 为 18,782 ms、10,747 ms、13,312 ms，P50 为
  13,312 ms、最大值为 18,782 ms；恢复 turn 为 8,611 ms、8,681 ms、
  15,053 ms，P50 为 8,681 ms、最大值为 15,053 ms。6 次任务均进入当前 Shim，
  `clientSource=vscode`、`target=remote`、`rootId=remote-primary` 和规范远端根
  正确，失败数和 `Unknown local project` 均为 0。
- 历史证据：`0.3.31` 候选热启动 3/3，P50 为 3,619 ms、最大值为 3,927 ms、
  失败数为 0；三次分别来自安装、首次授权和重新授权后的窗口重载。
- 历史证据：`0.3.34` 精确产物热启动 1 次为 3,812 ms，Remote SSH Shim 来自该安装
  候选。`0.3.32` 最终精确产物官方面板直接新建 1 次，在 84 ms 内创建
  conversation、5,984 ms 完成，自动选区正确且没有 `Unknown local project`。
- 历史证据：`0.3.30` 完成冷启动 2 次、官方 Codex 面板直接新建任务 3/3 和恢复原
  thread 3/3，且没有 `Unknown local project`；不复制为 `0.3.31` 当前值。
- 已完成：最终精确实现的官方 UI 直接新建和恢复最低样本、远端路由及
  `Unknown local project=0` 均已闭环。证据见
  `docs/acceptance/2026-07-27-release-0.3.39-official-task-samples.md`。

### L02 本地次级根授权

- 已完成：`0.3.31` 修复 Remote SSH 窗口中的本地选择器后，专用本地 Git 根授权、
  `local/secondary` 角色、重载持久化和规范远端主根并存均已验证。
- 已完成：同一 task 的本地/远端交替读取、树、搜索、Git、写入、补丁、重命名和删除
  闭环；本地冲突、部分失败、权限和大小上限均失败关闭，临时路径清理且 Git 干净。
- 已完成：撤销后既有 thread 和新 thread 均在 1 ms 内以 `COMMAND_DENIED` 失败；
  重新授权和重载后，本地基线、空测试路径、本地 Git 与远端读取全部恢复。完整证据见
  `docs/acceptance/2026-07-26-release-0.3.31-local-root-picker.md`。

### L03 官方界面上下文与本地 Core 诱饵

- 已完成：确认官方 `26.721.41059` 原生附件只接受 `file:` URI，不能附加 Remote SSH
  的 `vscode-remote:` 文件；`0.3.32` 改为每轮自动 IDE 背景，不要求手工加入附件。
- 已完成：注入任务分别验证自动远端选区和自动完整文件；最终精确产物的官方 UI
  直接新建任务在无附件、无 Bridge 命令时准确得到 `g1_1` 相对路径、真实 URI、选区
  范围和正文，审计正文命中为 0。
- 已完成：远端窗口显示授权本地次级根虚拟资源时，下一轮不注入该本地文件；编辑器
  正文不进入审计。当前候选官方恢复最低样本也已在 L01 闭环。
- 已完成：同名 Bridge 工具诱饵默认读取、搜索、补丁恢复和 `pwd` 全部落到
  `remote-primary`；9 个远端项目操作成功、本地项目操作为 0，远端文件恢复初始哈希。
  精确 `0.3.33` 随后在真实模型 task 中实际发起 5 次 Core 本地读取、Git 和写入
  尝试；全部在受限 sandbox 启动阶段失败，两个本地诱饵哈希不变、临时文件不存在。
  同一 turn 的远端同名读取和 `pwd` 成功；当前候选重载后的成功本地项目操作仍为 0。
- 已完成：旧本地会话的 `full-access` 曾因把显示模式误作权限档案 ID 而失败；
  `0.3.33` 改发 `sandbox=danger-full-access`。精确候选本地 thread
  `019fa2a9-d790-7c31-8628-1ac43a27936d` 在 12,696 ms 内完成文件读取和 Git，
  turn context 为 `approvalPolicy=never`、`permission_profile=disabled`。Remote SSH
  thread `019fa2ab-3a42-7821-b46c-f79c897a7fb7` 在 8,923 ms 内完成远端只读命令，
  Bridge 自动 `full-access` 审批 1 次、本地项目操作为 0。
- 注入方向的 Core 同名诱饵已完成；官方 UI 中的具体失败呈现不影响路由结论，统一放到
  L05 错误视觉确认。
- 普通本地窗口的正常项目语义已经由注入实机任务确认；进入 L06 唯一会话测试前关闭
  该窗口。

### L04 官方界面审批、取消与双向 thread

- 已完成：`0.3.40` 只投影线程响应，官方 UI 仍从配置默认值看到内部档案；
  `0.3.41` 隐藏配置默认值后初始切换恢复，但多次切换会从
  `permissionProfile/list` 再次选中内部档案。`0.3.42` 同时过滤该列表和扁平化
  权限来源键，用户重载后连续切换确认正常；协议探针只见三个官方内置档案，
  `default_permissions`、可见自定义档案和内部权限来源均为空。
- 已完成：`0.3.34` 原始 1,048,577 字节写入在 17 ms 内以 `OUTPUT_TRUNCATED`
  失败；写入请求发送后关闭活动 transport socket，29 ms 内返回 `RESULT_UNKNOWN`。
  两次后置检查均为原哈希、原前缀、临时文件 0，测试文件已清理。修复前相同关闭会使
  Promise 永久未终结，现已由 socket `close` 回归覆盖。
- 已完成：独立失联探针在远端临时写入出现时终止 Extension Host，`0.3.34` 自动换 PID
  后目标被部分新内容替换、临时文件为 0，错误为可重试
  `REMOTE_TRANSPORT_DISCONNECTED`。`0.3.36` 已要求写入短流在替换前失败、声明
  `executeStdinExactLength` 实际能力，并将此类已发送副作用响应提升为
  `RESULT_UNKNOWN`、查询幂等账本；实机原哈希不变但残留 1 个临时文件。`0.3.37`
  在临时文件创建前登记拥有进程，并以 `workspaceWriteOrphanCleanup` 能力要求新
  Executor 在就绪前清理当前工作区的死亡拥有者登记。重载后实际终止 PID `52431`，
  新 PID `56533` 就绪；原文件哈希和 28 字节大小不变，临时文件、登记、观察进程为
  0，返回不可重试 `RESULT_UNKNOWN`，审计无第二次 started，后置清理通过。
- 已完成：精确 `0.3.37` 外部 MCP 注入式 steer 保持同一 turn，运行中取消 3/3。
  `turn/interrupt` 到远端 `CANCELLED` 分别为 55、50、47 ms，三轮父子进程后置
  检查均为 0。固定远端 `codegraph_status` 5/5 成功，工具耗时 P50 为 9 ms、
  最大值为 66 ms、`isError=false`。读取取消后的完整历史时发现 turn 已为
  `interrupted`、审计已为 `CANCELLED`，但持久化 `commandExecution` 仍显示
  `inProgress`；`0.3.38` 已在 Shim 投影层修复并通过自动化。安装重载后实机取消
  从 `turn/interrupt` 到 `CANCELLED` 为 48 ms，即时完整 turn 读取中的
  `commandExecution` 为 `failed` 且带中断说明，父子进程为 0。开始下一 turn 后，
  官方 `thread/turns/list` 会省略上一中断 turn 的工具项，因此跨 turn 完整历史仍
  待处理，不能由即时读取结果替代。`0.3.39` 增加只保留已读取中断失败工具项的
  有界外部会话缓存，不读取 Codex 会话文件。精确候选重载后，注入样本在中断前独立
  确认远端父子进程存活；`turn/interrupt` 46 ms 返回，远端命令在 566 ms 以
  `CANCELLED` 终结。即时读取和后置新 turn 完成后的再次读取均只有同一失败
  `commandExecution` 及中断说明，父子进程为 0，跨 turn 外部历史已闭环。
- 已完成：精确 `0.3.42` 在需审批模式下从官方 UI 接受远端命令。官方日志记录
  `item/commandExecution/requestApproval` 的人工 `accept`；Bridge 审批审计为
  `automatic=false`、`decision=accept`。同一调用仅在 `g1_1` 的
  `remote-primary`、规范 cwd `/home/unitree/mimiclite-sim2real` 启动 1 次，
  421 ms 成功结束，幂等结果为 `executed`。
- 已完成：官方审批卡片实测只显示“拒绝/允许一次”，审批未决时不显示输入区或停止
  turn 入口。用户点击“拒绝”后，审批审计为 `decision=decline`，执行审计只有
  `cancelled` 而没有 `started`；后置目录和活动 VS Code transport 探针均确认标记
  不存在、相关进程为 0。
- 已完成：审批等待中由附着 MCP 对同一 turn 发起 `turn/interrupt`，46 ms 返回；
  审批为 `decision=cancelled`。路由层先写入 `started` 审计再发现已中断信号并在
  0 ms 内取消，但没有进入远端执行器；后置标记不存在、相关进程为 0。
- 已完成：官方 UI 运行中取消达到 3/3。三轮 `remote_tool.cancel` 均来自
  `vscode`、`cancelledCalls=1`；远端命令分别运行 8,906、2,739、6,680 ms，
  取消请求到 `CANCELLED` 分别为 97、78、77 ms，P50 为 78 ms、最大值为
  97 ms、失败数为 0。后两个命令分别记录父子 PID `49701/49710` 和
  `49960/49969`，活动 VS Code transport 在 366、380 ms 的后置探针中确认存活数
  均为 0；首轮及当前全部相关进程也为 0。
- 已完成官方 UI new turn 的外部同时观测，流式文本、工具、终态和完整历史可见，
  精确重复帧为 0；官方 UI cancel 另已达到 3/3。官方 UI 同 turn steer 的同时观测
  已关闭（未执行，不计为通过）。

### L05 远程文件、Diff 与错误视觉

- 已关闭（未执行，不计为通过）：本地/远程同名文件、行列定位和 Diff 视觉确认。
- 已关闭（未执行，不计为通过）：过期快照、越界路径、已撤销根和过期资源的错误视觉。

### L06 托管入口与外部权限撤销

- 已关闭（未执行，不计为通过）：单活动窗口的普通 `codex` 唯一会话自动附着。
- 已关闭（未执行，不计为通过）：外部 CLI/MCP 集成停用、权限撤销和重新启用。

### L07 Executor 失联与最终窗口关闭

- 已关闭（未执行，不计为通过）：Remote Executor 独立失联的组合矩阵。
- 已关闭（未执行，不计为通过）：Remote SSH 整窗带载关闭、重开及全链路清理。
- 已关闭（未执行，不计为通过）：最终 MimicLite task 和全范围安全扫描。

本轮收尾已删除持久化本地次级根授权、本地授权根、控制目录及远端 L03/L04 夹具；
控制目录恢复 `0500`，远端夹具计数为 0 且主根保持非 Git。

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

当前状态：Windows x64 环境已投入逐目标实测，Executor 同步、官方新任务、远端项目操作、
显式/普通 CLI、外部 MCP、停用恢复、npm 升级恢复和官方 Git 初始化 watcher 路径兼容
已分别形成证据。`0.3.60` 重载后重复 `git-init-watcher ENOENT` 从每五秒一次降为 0，
同一候选的远端 Git、README 读取和 `pwd` 均通过。`0.3.61` 又完成统一工具路由清单实测：
23 条路由进入 Shim 审计、thread 指令和每轮 JSON 上下文，MCP family 不再被误报为具体
工具可用；无 `target/rootId` 的远端 `pwd` 通过。一次 `119,489 ms` 动态工具转发延迟及
冷连接 `30,016 ms` 超时已回填 README 活动 TODO；完整 M01-M11 重跑、双平台 stage
收集和量化门禁仍是后续 `0.4.0` 决策前的活动前置。

- 在 Windows x64 原生执行依赖安装、类型检查、测试、构建、SEA Shim 冒烟和构包。
- 在 Windows 执行 `npm run package:stage`，与同版本 Linux stage 一并运行
  `npm run package:collect -- <linux-stage-dir> <windows-stage-dir>` 和
  `npm run package:verify`；核对 `dist/` 只保留当前双平台 Controller、版本化
  Executor 和无版本副本。
- 安装 Windows Controller VSIX，确认只使用 `.exe` Shim，包内没有 Linux CJS Shim。
- 重跑 M01-M11 中所有平台相关链路，不得复用 Linux 结果。
- 特别核对 Named Pipe、官方任务创建、Remote SSH、进程树取消、MCP relay、设置恢复、
  CLI 托管入口、远程 URI/Diff 和双端写入。
- Windows 与 Linux 的版本、日志、指标和最终结论分别记录。

## D. 最终 P0

### M14 MimicLite 真实项目闭环

当前状态：不发布 `0.4.0`。Windows M13 验证正常后才恢复双平台 G0-G9 和最终声明。

- 在目标 Remote SSH 主机与 MimicLite 仓库完成官方任务新建、恢复和多轮执行。
- 覆盖读取、搜索、Git、命令、MCP、双端写入、远程 Diff、后台任务、取消和断线恢复。
- 确认所有项目操作位于预期目标端，无第二次认证、无远端 Codex、无本地项目误操作。
- 按 G0-G9 和必填量化指标生成最终不可覆盖的候选验收记录。
- Linux 与 Windows 均满足支持声明后，才更新兼容矩阵中的最终支持范围。
