# Codex Remote Bridge

这是 `docs/codex-vscode-remote-bridge-requirements.md` 的可行性验证实现。目标是让官方
Codex VS Code 扩展和 Codex app-server 留在可联网的本地 Windows x64 或 Ubuntu x64，
默认复用 VS Code Remote SSH 已认证的远程通道访问离线 Ubuntu 工作区；独立 OpenSSH
执行器保留为回退模式。

> 当前版本是读操作和受审批非交互命令的技术原型，不是完整 MVP。远程写入、运行中
> 取消和断线恢复尚未完成，不要用于无人值守的生产训练。

## 当前实现

- Bridge 扩展固定声明为 VS Code `ui` 扩展，并提供需求中的 6 个命令。
- 单根 Remote SSH 工作区打开后自动识别主机和根目录、保存配置并连接，无需手动启动。
- 首次接管官方 Codex 设置时自动重载一次；后续打开工作区直接进入 `ready`。
- `chatgpt.cliExecutable` 虽为全局设置，但 Shim 仅在对应 Remote SSH 扩展宿主带有会话
  配置时接管；普通本地窗口完全透传官方 Codex。
- 每个工作区首次就绪时把 Codex Webview 恢复到默认右侧栏，修复旧布局中的灰色面板。
- 修改 `chatgpt.cliExecutable` 和 `remote.extensionKind` 前保存原值，并提供恢复命令。
- 按本地平台自动探测 Codex：Windows 优先发现原生 npm `codex.exe` 和官方扩展内置
  CLI，Linux 探测 `~/.local/bin/codex` 等常见路径；不会把另一平台的路径写死到设置。
- Windows 使用 Node SEA 打包的原生 `codex-bridge-shim.exe`，Linux 使用 CJS Shim；
  启动器安装到按版本和内容哈希隔离的本地状态目录，扩展升级后路径仍然有效。
- 自动识别并迁移 Bridge 旧版本或另一平台遗留的 `chatgpt.cliExecutable`，同时只恢复
  Bridge 实际接管过的官方设置，不覆盖用户后来新增的其他扩展映射。
- CLI Shim 代理 app-server JSONL，固定本地只读控制目录，并注入实验协议能力。
- 新线程注入远程读取、单层/有界目录树、文本搜索、`git status` 和受审批命令工具。
- Bridge 自有工具在返回官方界面前投影为原生 `commandExecution` 项，使用本地 Codex
  相同的读取、列目录、搜索和命令外观，不修改官方扩展文件。
- `remote_exec` 只接受结构化 `argv`；“完全访问”模式不重复询问，其他权限模式使用
  官方命令审批并显示远程主机、规范化 `cwd`、完整命令和环境变量变更。
- stdout/stderr 实时转发；自动放行和人工审批结果都写入本地审计日志。
- 默认 `vscode-remote` 模式自动部署一个不含 Codex 和凭据的 Workspace Executor，
  通过 VS Code Remote Extension Host 执行结构化操作；密码、公钥和 Agent 认证均由
  已建立的 Remote SSH 窗口处理，Bridge 不再发起第二次认证。
- 本地 Shim 与 UI 扩展通过带随机会话令牌的本机 Named Pipe/Unix socket 通信；UI
  扩展再通过 VS Code 命令通道调用远端 Executor。
- 回退 `openssh` 模式使用结构化 `argv`、严格主机密钥校验、连接超时和输出上限。
- 直连主机可单独配置 SSH 用户、端口和可选 IdentityFile；私钥内容不由 Bridge 读取。
- Linux 上同一 `connectionId` 使用受限 ControlMaster 复用，并在停止时显式关闭；
  Windows 为兼容系统 OpenSSH，使用独立 SSH 会话。
- 路径同时经过词法限制和远端 `realpath` 校验，符号链接不能逃逸工作区。
- 远端缺少 `rg` 时自动使用不跟随目录符号链接的 GNU `grep` 搜索。
- SSH 子进程只继承必要环境变量，不继承 Codex、OpenAI 或其他应用凭据。
- 未知 app-server 服务端请求默认拒绝；操作审计日志只保存在本地并结构化脱敏。
- 协议子集由本机 Codex `0.144.5` 生成，运行时要求精确版本匹配。
- Remote SSH 窗口自动扫描本机 Codex MCP：本机能力继续留在本机；满足安全条件的工作区
  stdio MCP 在默认模式下复用当前 VS Code Remote 通道，在回退模式下通过 OpenSSH 中转。
- 可按窗口切换 MCP 访问范围；显式选择 `all` 时启用全部已配置服务、清空工具禁用
  列表，并将服务默认工具审批设为 `approve`，不改写全局 Codex 配置。

## 尚未实现

- 哈希保护的远程写入、补丁、删除和重命名。
- 运行中命令取消、幂等键、后台任务和断线后结果确认。
- 对 Codex Core 内置本地 Shell 工具的执行前硬阻断。
- 在目标 Remote SSH 主机和 MimicLite 仓库上的完整 P0 验收。

最后两项仍是阶段 C 的安全门槛。当前 Shim 会把 app-server 放在无项目文件且不可写
的本地控制目录，并通过指令要求只用远程工具，但这不能替代 Core 层的强制路由控制。

远程工作区中的 Codex 可以继续调用本地 app-server 原有的 MCP、App 和 Connector
增强能力，它们无需安装到远端。Bridge 会扫描本机 MCP 配置，但不会修改全局
`~/.codex/config.toml`：HTTP MCP、包含环境变量/本地工作目录的服务和包管理器启动器
继续留在本机；无凭据的直接 stdio 可执行文件只有在远端也存在时才通过当前 Bridge 通道中转。
远端启动器自动探测 `PATH`、`~/.local/bin` 和 `/usr/local/bin`，并以远程工作区为
当前目录。默认 `vscode-remote` 模式由本地 MCP relay、窗口级认证 IPC 和 Remote
Executor 中的长生命周期子进程组成，MCP 字节流与普通远程操作共用已认证的 VS Code
Remote SSH 连接，不再发起第二次 SSH 登录。该通道适用于所有通过安全筛选的直接 stdio
MCP；CodeGraph 只是首个工作区参数适配器，会额外绑定远程索引根目录。可将
`codexRemoteBridge.remoteMcpRouting` 设为 `local`，让所有 MCP 保持本机运行。
`codexRemoteBridge.remoteMcpAccess` 默认为 `enabled`，保留用户已有启用和审批策略；
设为 `all` 后只对当前 Remote SSH 窗口的 app-server 尝试启用已配置 MCP、清空
`disabled_tools`，并设置 `default_tools_approval_mode="approve"`。覆盖会先由同版本
Codex 校验；若插件配置层的局部覆盖会替换 transport，该服务保持原配置，避免拖垮
app-server。服务自身未提供的工具不会被 Bridge 虚构，已有 `enabled_tools` allowlist
或托管策略仍是上层边界。

## 开发与自测

```bash
npm install
npm run check
```

`npm run check` 依次执行 TypeScript 类型检查、单元/集成测试、扩展和 Shim 构建、
本地窗口透传与 Remote SSH 窗口初始化、线程列表和线程创建冒烟测试，以及 VSIX 打包。
当前平台的 VSIX 使用 `npm run package`；在 Windows 构建机上可用
`npm run package:all` 同时产出 Windows x64 和 Linux x64 两个目标包。

真实远端只读验收使用环境变量提供目标，不把主机和私钥路径写入仓库：

```bash
CODEX_BRIDGE_REMOTE_TEST=1 \
CODEX_BRIDGE_TEST_HOST=example-host \
CODEX_BRIDGE_TEST_USER=root \
CODEX_BRIDGE_TEST_PORT=22 \
CODEX_BRIDGE_TEST_WORKSPACE=/absolute/remote/workspace \
npm run test:remote
```

需要指定密钥时额外设置 `CODEX_BRIDGE_TEST_IDENTITY=/absolute/local/key/path`。

生成物：

- `dist/codex-bridge-shim.exe`（Windows 构建）
- `dist/codex-bridge-shim.cjs`
- `dist/codex-remote-bridge-<version>-win32-x64.vsix`
- `dist/codex-remote-bridge-<version>-linux-x64.vsix`
- `dist/codex-remote-bridge-executor-<version>-linux-x64.vsix`

它们属于同一个扩展 ID 和同一套源码，只是针对本地 Extension Host 平台的两个分发
产物。Controller VSIX 内嵌匹配版本的远端 Executor，并在 Remote SSH 窗口中通过
VS Code 文件系统和扩展安装服务自动部署。Windows SEA 启动器包含 Node 运行时，因此
VSIX 明显大于 Linux 包，并且当前构建未做代码签名；发布前应加入正式签名流程。

重新生成匹配当前 Codex 版本的协议子集：

```bash
npm run protocol:generate
```

生成后必须重新运行 `npm run check`，并更新兼容矩阵。

## 升级与发布跟进

兼容集合中任一组件升级时，按 `docs/upgrade-tracking.md` 的触发矩阵、硬门禁和量化
指标执行，并从 `docs/acceptance/release-template.md` 创建一份不可覆盖的候选版本记录。
当前基线为 `docs/acceptance/2026-07-18-release-0.2.7.md`。

Windows x64 和 Linux x64 必须分别填写运行结果。`npm run package:all` 能证明两个目标
VSIX 已生成并完成平台内容隔离，但不能用 Windows 构建机上的 Linux 包替代 Linux 本地
Extension Host、CJS Shim、官方任务创建和真实 Remote SSH 验收。缺少的数据写
`待补测`，并限制兼容性声明范围。

## 试用流程

1. 按本地平台安装对应 VSIX：Windows 使用 `win32-x64`，Ubuntu 使用 `linux-x64`。
2. 用 Remote SSH 打开单个远程工作区。
3. Bridge 自动保存当前主机和根目录、部署远端 Executor；首次接管设置或安装
   Executor 时窗口会自动重载。
4. 等待状态栏显示 `Codex: local -> <host> (ready)`。
5. 运行 `Codex Bridge: Run Diagnostics`，确认本地扩展宿主、官方设置、远端身份和
   `remote.codexInstalled=false`。
6. 需要全部 MCP 时，将 `codexRemoteBridge.remoteMcpAccess` 设为 `all` 后完整重启
   VS Code；审计中的 `remoteMcpAccess` 应为 `all`。
7. 新建 Codex 任务，验证远程读取、目录树、搜索、`git status` 和 MCP 工具。
8. 请求执行 `pwd` 或仓库测试命令；“完全访问”应直接执行，其他模式应显示审批。
9. 停用原型前执行 `Codex Bridge: Restore Official Codex Settings`；该命令同时关闭
   `codexRemoteBridge.autoInitialize`，避免重载后再次接管。

自动流程仅在 `codexRemoteBridge.autoInitialize=true`、当前窗口为 Remote SSH 且恰好
打开一个远程根目录时运行。关闭该设置后仍可使用 Configure 和 Start 命令手动控制。
普通本地工作区即使同时打开，也不会读取远程 Bridge 配置或重写 app-server 消息。

本地配置和审计日志的默认位置如下：

- Windows：`%APPDATA%\codex-remote-bridge\config.json` 和
  `%LOCALAPPDATA%\codex-remote-bridge\audit.jsonl`。
- Linux：`~/.config/codex-remote-bridge/config.json` 和
  `~/.local/state/codex-remote-bridge/audit.jsonl`。

Remote SSH 窗口会额外创建按本地 Extension Host PID 隔离的会话配置；其中只保存
本机 IPC 端点和随机会话令牌，不保存 SSH 密码、私钥或 OpenAI Token。默认连接模式为
`vscode-remote`；需要独立连接时可选择 `openssh`，Windows 会自动发现系统 OpenSSH，
也可通过 `codexRemoteBridge.sshExecutable` 指定路径或命令名。
Codex Core 会清理 stdio MCP 子进程的 `CODEX_BRIDGE_*` 环境变量，因此 Bridge 会把该
会话配置文件的绝对路径作为 `mcp-proxy --session-config` 参数传递；随机令牌仍只存放在
受限文件中，不进入进程命令行。

更多边界与验收信息见 `docs/implementation-status.md`、`docs/compatibility.md`、
`docs/upgrade-tracking.md` 和 `docs/security-notes.md`。
