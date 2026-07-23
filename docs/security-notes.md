# 安全边界

## 已强制执行

- 项目身份由 `hostId + rootId + target + workspaceRoot + relativePath` 共同决定。
- 配置 v2 必须且只能有一个 `remote/primary` 根；v1 的单远程根会迁移为该记录。
  `workspaceRoot` 只是运行期兼容别名，不一致时失败关闭。本地根只能是
  `local/secondary`，且在授权入口和本地执行器实现前无法被工具访问。
- `localExecution` 固定为 `deny`，配置无法改成允许。
- 默认 `vscode-remote` 模式只调用当前 Remote SSH 窗口中的 Workspace Executor，不读取
  密码、私钥或 VS Code Remote SSH 的底层连接凭据，也不建立第二条 SSH 连接。
- 本地 Shim 到 UI 扩展的 IPC 使用每窗口随机令牌认证；令牌只写入当前用户状态目录的
  会话配置，不发送到远端，不属于 OpenAI 或 SSH 凭据。
- VS Code Codex 对话控制使用两个仅监听 `127.0.0.1` 的 WebSocket 边界：官方
  app-server 上游和外部客户端网关分别使用独立随机能力令牌。令牌文件与会话描述符
  位于当前用户状态目录并限制为 `0600`，目录限制为 `0700`；令牌不进入 MCP 配置、
  进程参数、审计、远端环境或仓库。
- Controller 激活时自动维护自有 `codex_vscode_remote_bridge` 注册、显式
  `codex-vscode` 启动器和 POSIX 普通 `codex` 启动器，并随 Shim 内容地址变化刷新。
  普通入口只接管当前配置解析到的符号链接，记录官方 CLI 的绝对路径和原始链接目标；
  不接管普通文件或不匹配的链接。显式停用会原样恢复官方链接、删除其他托管文件并
  持久阻止后续自动重建，重新启用后才恢复。MCP 不读取或复制 CLI 的 OpenAI 登录材料。
- 双向实时 CLI 只连接当前用户的 loopback 网关并恢复已有 VS Code thread。托管附着
  入口在启动子进程时读取短期能力令牌，通过描述符指定的环境变量传递给 Codex，绝不
  把令牌放入 argv、终端命令、日志、审计或持久 CLI 配置；网关退出后令牌立即失效。
- 普通本地窗口也经过该共享网关，但不读取 Remote SSH 会话配置，不改写 `cwd`、权限、
  审批策略或客户端消息；会话描述符只记录附着所需的 host、workspace 和 thread
  标识，不持久化对话正文。
- 远端 Executor 校验请求工作区必须与当前打开的 `vscode-remote` 根目录完全一致，并在
  执行前再次完成规范路径和符号链接边界检查。
- 远端目标必须是具体 OpenSSH 主机别名，不接受通配符或选项注入。
- SSH 明确启用严格主机密钥校验，不使用端口转发，不继承应用凭据环境变量。
- IdentityFile 仅作为路径传给 OpenSSH；诊断和审计会隐藏该字段。
- Linux 的 ControlMaster socket 位于权限 `0700` 的临时目录，停止执行器时发送
  `-O exit` 并清理。Windows 不启用 ControlMaster，避免依赖不稳定的本地 socket 语义。
- 自动初始化只接受当前 Remote SSH 窗口中唯一的远程根目录，不在本地窗口或多根目录
  场景猜测目标；用户打开该单根目录即作为只读访问范围选择。
- 首次接管官方设置前保存原值；只记录 Bridge 实际管理的 `openai.chatgpt` 映射，恢复
  时保留其他扩展后来发生的设置变化。恢复命令同时关闭 `autoInitialize`。
- 结构化命令参数经过 POSIX 单引号转义；用户输入不能改变远端 Shell 参数边界。
- Shim 在改写前按线程记录官方权限模式；`full-access` 或 `approvalPolicy=never` 自动
  放行远程命令，其他模式使用绑定单个调用 ID 的官方命令审批。
- 权限映射只作用于 Remote Executor；传给本地 app-server 的项目目录仍是空控制目录，
  `permissions` 仍被移除，sandbox 仍固定为只读。
- stdout/stderr 以官方命令输出事件流式返回；人工拒绝或审批超时不会启动远端进程，
  完全访问的自动放行会单独写入审计日志。
- 所有文件路径先限制在根目录，再在远端解析符号链接并二次校验。
- 断线、超时和取消不会触发本地回退；有副作用调用应返回 `RESULT_UNKNOWN`。
- Linux 本地配置和审计日志权限为 `0600`，控制目录权限为 `0500`。Windows 不模拟
  POSIX mode，文件位于当前用户的 `%APPDATA%`/`%LOCALAPPDATA%` 下并继承用户配置目录
  ACL；高安全场景仍应显式审计该目录 ACL。
- Codex 和 SSH 可执行文件按本地平台发现；Windows 只接受原生 `codex.exe`/`ssh.exe`
  候选，不会执行遗留的 Linux 绝对路径。显式配置仍应指向受信任文件。
- 未知 app-server 服务端请求默认返回 `-32601`。

## 尚未形成硬保证

Codex Core 仍然拥有内置本地 Shell/文件工具。Shim 已把本地 `cwd` 固定到空的只读
控制目录，并注入只使用 `remote_*` 工具的开发者指令，但提示词不是安全边界。

在以下任一方案完成前，不得宣称满足完整的 `INV-004`、`POLICY-006` 和阶段 C：

1. Codex app-server 提供正式能力，可按线程禁用全部内置本地 Shell/文件工具；或
2. 修改开源 Codex Core，增加强制远程执行后端；或
3. 用经过验证的操作系统沙箱阻止 app-server 创建本地项目工具进程，同时不破坏认证
   和 app-server 协议。

远程写入仍必须先接入官方审批链路，并把审批结果绑定到基础哈希、规范化参数和当前
`connectionId`，之后才能注入对应动态工具。当前通用命令已经接入一次性审批，但
运行中取消、断线后的进程身份确认和 Core 内置本地工具硬阻断仍未完成。

`remote_exec` 约束启动目录位于工作区，但获批命令本身拥有远端 SSH 账号的权限，
可以显式访问工作区外路径；它不是远端文件系统沙箱。审批前必须检查完整命令。需要
Shell 语义时会以 `bash -lc` 等结构化参数呈现，而不是隐藏成未展示的本地字符串。
选择“完全访问”意味着主动放弃上述逐次检查，但不会放开本地项目目录。

本地 MCP、App 和 Connector 允许用于远程任务的增强能力。Bridge 的自动 MCP 路由
只处理无环境变量、无本地 `cwd`、非包管理器启动且远端存在同名可执行文件的 stdio
服务；不会向远端复制 Token、配置环境或本地凭据。HTTP 和其他服务继续在本机运行。
默认模式下，stdio 字节流经窗口级随机令牌认证的本机 IPC 和现有 VS Code Remote 命令
通道传输；远端 Executor 只直接启动通过白名单校验的同名可执行文件，不经过 Shell，
并在 relay 断开、窗口关闭或扩展停用时终止对应子进程。单帧上限固定为 256 KiB。
由于 Codex Core 会清理 MCP 子进程环境，命令行只显式携带本地会话配置文件路径；随机
认证令牌保留在当前用户可读的会话文件内，不写入命令行、审计或远端环境。
路由器只改变 MCP 进程传输位置，不猜测或改写未知工具参数；需要工作区参数差异的
服务必须有显式适配器，否则应使用 Bridge 的 `remote_*` 工具。
适配器是代码内的受控注册表，只能返回经过名称、敏感词、字符集、长度和数量校验的
非凭据环境变化。app-server 参数和审计只记录适配器 ID；默认 VS Code Remote 通道由
Executor 在远端解析，OpenSSH 回退将适配值放在 MCP 字节流之前的 stdin 控制头中，
不把值写入 SSH 命令行。不会读取或复制 MCP 配置的 `env`、`env_vars`、本地 `cwd`
或本机进程环境快照。

`remoteMcpAccess=all` 是显式的宽权限模式。它仅在当前 Remote SSH app-server 进程
中尝试把已配置 MCP 设为启用、清空 `disabled_tools`，并将服务默认工具审批设为
`approve`；不会改写 `~/.codex/config.toml`。覆盖必须先通过同版本 Codex 配置校验，
不兼容的插件层服务保持原策略和 transport。这会让通过校验的本地 HTTP/凭据型 MCP 也能被当前
远程任务直接调用，并允许有副作用的 MCP 工具不再逐次询问。服务端未注册的工具、
已有 `enabled_tools` allowlist、显式单工具规则和托管策略仍优先，Bridge 不绕过这些
上层边界。默认值 `enabled` 保持最小权限行为。

外部对话介入继承目标 VS Code thread 的 Codex 权限模式，而不是发起调用的 CLI thread
权限。共享网关在所有客户端连接间复用同一权限跟踪状态；目标 thread 为
`full-access` 时，外部介入触发的 `remote_exec` 不增加 Bridge 二次审批并保留自动放行
审计。其他模式下，当前 MCP 无法承载官方审批 UI 时会明确拒绝，不能静默升级权限。
连接来源、请求方法和结果状态会审计，但对话文本和文件正文不会写入审计。

## 操作要求

- 默认模式要求匹配版本的 Remote Executor 安装在远端 Workspace Extension Host；
  Controller 通过 VS Code Remote 文件系统传输内嵌 VSIX，并在安装后重载一次窗口。
- 首次连接前由用户通过正常 OpenSSH 流程确认主机密钥。
- 诊断中若 `remote.codexInstalled=true`，验收立即失败。
- SSH 主机密钥变化、远端身份变化或根目录变为符号链接时停止使用并人工检查。
- Linux 进程异常退出时 ControlMaster 最多保留约 15 秒；正式发布前仍需加入启动时
  遗留 socket 扫描和崩溃清理验证。Windows 每次使用独立 SSH 会话，不受此项影响。
- 审计材料不得包含完整文件内容、私钥、Token 或环境变量快照。
- MCP 扫描结果只记录服务名和本地/远端路由，不得记录 MCP 环境变量值。
- 启用 `remoteMcpAccess=all` 前确认当前 Codex 配置中的全部 MCP 都可信。
