# Codex Remote Bridge

## 概览

Codex Remote Bridge 让官方 Codex VS Code 扩展及其内置 app-server 保持在本机运行，
同时把经过授权的项目操作路由到当前 VS Code Remote SSH 工作区。默认链路复用 VS Code
已经建立的远程连接，不读取 SSH 密码或私钥，也不会在远端启动 Codex。

> 当前源码版本为 `0.3.58`。Windows 已完成 npm `codex.cmd` 解析、显式
> `codex-vscode.exe` TUI、外部 MCP、历史 thread 同步、无 rollout 冷启动降级和退出
> 清理实测。Windows 普通 `codex` 同名自动入口、官方 Remote SSH git watcher 噪声及
> 完整双平台门禁仍待处理。
> 在双平台门禁完成前不发布 `0.4.0`，也不扩大支持声明。

## 工作原理

```text
官方 Codex UI / 本地 Codex CLI
              |
       本地 Shim 与 Controller
              |
    VS Code Remote SSH 已认证通道
              |
      Remote Workspace Executor
              |
          远程工作区
```

- Controller 是本地 `ui` 扩展，负责配置、审批、审计、资源映射和远程 Executor 部署。
- Shim 代理官方扩展内置 app-server，并为 Remote SSH thread 注入 Bridge 工具和安全策略。
- Remote Executor 是远端 Workspace 扩展，只执行结构化、受根目录约束的操作。
- 默认 `vscode-remote` 模式复用活动 Remote SSH transport；`openssh` 仅作为显式回退。
- 官方扩展、内置 Codex、Controller、Shim 和 Executor 组成兼容集合，但版本值只用于
  诊断和回归触发，不作为运行时接纳条件。

## 主要能力

- 自动识别单根 Remote SSH 工作区；每次初始化核对远端实际包版本，不一致时通过活动
  VS Code Remote SSH transport 部署当前 Controller 内嵌的配套 Remote Executor 并重载。
- 远程读取、目录树、字面搜索、Git 状态和结构化命令执行。
- 基于 SHA-256 的双端安全写入、精确补丁、重命名和删除。
- 远程命令和重要写操作沿用官方 Codex 权限模式及审批界面。
- 运行中取消、进程组终止、有界幂等账本和断线结果查询。
- 受控后台任务的启动、状态、增量日志和取消。
- 远程文件定位、选区、资源 URI 和 Diff 映射。
- 每轮自动采集当前 Remote SSH 编辑器文件或非空选区作为 IDE 背景。
- 符合安全条件的 stdio MCP 可通过当前 VS Code Remote 通道在远端运行。
- 本地 Codex CLI 可附着和介入活动 VS Code Codex thread。
- 普通本地窗口按当前唯一文件工作区过滤任务列表；Remote SSH 窗口按主机和远程根隔离。
- 本地次级根必须由用户显式授权，并可随时撤销。
- 本地结构化审计不记录文件正文、密码、私钥、Token 或完整环境变量。

## 支持边界

- 本地 Controller 目标为 Linux x64 或 Windows x64；两者必须在各自原生平台构建和验收。
- 远端目标为 VS Code Remote SSH 打开的 Linux x64 工作区。
- 自动初始化只接受当前窗口中唯一的远程工作区根，不猜测多根工作区。
- 默认模式不会建立第二条 SSH 认证链路。
- `remote_exec` 限制启动目录但不是远端文件系统沙箱；批准命令前仍需检查完整参数。
- 选择“完全访问”会取消逐次审批，但不会开放本地项目目录。
- Windows、Linux 和 OpenSSH 的构包或运行结果不能互相替代。

当前组件矩阵和已验证范围见
[兼容矩阵](https://github.com/RaraAlu/remote_codex/blob/main/docs/compatibility.md)，
完整安全说明见
[安全边界](https://github.com/RaraAlu/remote_codex/blob/main/docs/security-notes.md)。

## 安装与启动

1. 安装与本地平台匹配的 Controller VSIX：
   - Linux x64：`codex-remote-bridge-<version>-linux-x64.vsix`
   - Windows x64：`codex-remote-bridge-<version>-win32-x64.vsix`
2. 使用 VS Code Remote SSH 打开一个远程工作区根目录。
3. 等待 Bridge 自动配置、部署 Executor，并在必要时完成一次窗口重载。
4. 状态栏可能先显示远端 transport 已就绪但仍在等待 Codex；只有 Shim 进程存活且
   官方 app-server 完成 `initialize` 后才显示 `Codex: local -> <host> (ready)`。
5. 运行 `Codex Bridge: Run Diagnostics`，确认远端身份、工作区根和
   `remote.codexInstalled=false`，并检查 `shimStarted`、`appServerInitialized`、
   `shimLastExitCode` 与 `appServerLastError`。
6. 在官方 Codex 面板创建任务，并通过日志和审计确认项目操作位于远端。

关闭 `codexRemoteBridge.autoInitialize` 后，可以使用 Configure 和 Start 命令手动
控制。停用前应执行 `Codex Bridge: Restore Official Codex Settings`，恢复 Bridge
接管过的官方设置。

## 常用命令


| 命令                                              | 用途                               |
| ------------------------------------------------- | ---------------------------------- |
| `Codex Bridge: Configure Current Remote`          | 保存当前 Remote SSH 主机和工作区根 |
| `Codex Bridge: Start`                             | 启动或重新连接 Bridge              |
| `Codex Bridge: Stop`                              | 停止当前 Bridge 会话               |
| `Codex Bridge: Run Diagnostics`                   | 显示脱敏后的组件、连接和能力状态   |
| `Codex Bridge: Show Audit Log`                    | 打开本地审计日志                   |
| `Codex Bridge: Authorize Local Root`              | 授权一个本地次级根                 |
| `Codex Bridge: Revoke Local Root`                 | 撤销本地次级根授权                 |
| `Codex Bridge: Add Remote File to Next Turn`      | 为下一轮显式加入当前远程文件       |
| `Codex Bridge: Add Remote Selection to Next Turn` | 为下一轮显式加入当前远程选区       |
| `Codex Bridge: Enable Automatic CLI Integration`  | 启用本地 Codex CLI 自动附着        |
| `Codex Bridge: Disable Automatic CLI Integration` | 停用 CLI 集成并恢复托管入口        |
| `Codex Bridge: Restore Official Codex Settings`   | 恢复 Bridge 接管前的官方设置       |

## 主要设置


| 设置                                      | 默认值          | 说明                                       |
| ----------------------------------------- | --------------- | ------------------------------------------ |
| `codexRemoteBridge.autoInitialize`        | `true`          | 单根 Remote SSH 窗口自动配置和连接         |
| `codexRemoteBridge.connectionMode`        | `vscode-remote` | 使用 VS Code transport 或显式 OpenSSH 回退 |
| `codexRemoteBridge.remoteMcpRouting`      | `auto`          | 自动路由合格 stdio MCP，或全部保留本机     |
| `codexRemoteBridge.remoteMcpAccess`       | `enabled`       | 保留现有 MCP 策略；`all` 为显式宽权限模式  |
| `codexRemoteBridge.commandTimeoutMs`      | `120000`        | 单次远程操作超时                           |
| `codexRemoteBridge.maxOutputBytes`        | `10485760`      | 每个远程输出流的最大捕获字节数             |
| `codexRemoteBridge.connectTimeoutSeconds` | `10`            | OpenSSH 连接超时                           |
| `codexRemoteBridge.sshExecutable`         | `ssh`           | OpenSSH 回退使用的本地客户端               |
| `codexRemoteBridge.externalCliExecutable` | `codex`         | 外部 CLI 集成使用的本地 Codex 入口         |

`remoteMcpAccess=all` 会在当前 Remote SSH app-server 进程中尝试启用通过校验的 MCP，
清空其禁用工具列表并将默认工具审批设为允许。它不会修改全局 Codex 配置，但可能开放
具有副作用的本地或远端 MCP 工具，仅应在信任全部相关服务时使用。

## CLI 介入

在 POSIX 上启用自动 CLI 集成后，无参数 `codex` 只会自动附着工作目录与当前目录完全一致的活动
VS Code thread。当前目录没有匹配会话时透传官方 Codex CLI，不会被其他工作区的活动
会话拦截；同一目录存在多个匹配会话时失败关闭，可使用：

```bash
codex-vscode --session-pid <pid>
```

Windows 不替换 npm 管理的 `codex`、`codex.cmd` 或 `codex.ps1`；当前使用安装在
`%LOCALAPPDATA%\codex-remote-bridge\bin\codex-vscode.exe` 的显式入口。

介入能力包括列出对话、读取完整 turn、发起新 turn 或 steer，以及中断运行中的 turn。
已经启动的旧 CLI 进程不能热切换 app-server，需要退出后重新启动。停用集成后也应
重新启动 CLI，使恢复后的官方入口生效。

## 开发与验证

```bash
npm install
npm run check
```

`npm run check` 依次执行类型检查、测试、构建、Shim 冒烟和当前平台构包。真实远端
只读测试通过环境变量显式启用：

```bash
CODEX_BRIDGE_REMOTE_TEST=1 \
CODEX_BRIDGE_TEST_HOST=example-host \
CODEX_BRIDGE_TEST_USER=root \
CODEX_BRIDGE_TEST_PORT=22 \
CODEX_BRIDGE_TEST_WORKSPACE=/absolute/remote/workspace \
npm run test:remote
```

需要指定密钥时设置
`CODEX_BRIDGE_TEST_IDENTITY=/absolute/local/key/path`。仓库和验收材料不得记录凭据。

发布候选必须在 Linux x64 与 Windows x64 原生构建机分别执行：

```bash
npm run check
npm run package:stage
```

随后在收集机验证两个 stage：

```bash
npm run package:collect -- <linux-stage-dir> <windows-stage-dir>
npm run package:verify
```

跨平台构包只能证明包内容，不能替代对应平台的 Extension Host、Shim、官方任务和
Remote SSH 实机验证。完整门禁和量化指标见
[升级跟进](https://github.com/RaraAlu/remote_codex/blob/main/docs/upgrade-tracking.md)。

## 产物

- `dist/codex-bridge-shim.exe`：Windows x64 自包含 Shim 构建输出。
- `dist/codex-bridge-shim`：Linux x64 自包含 Shim 构建输出。
- `dist/codex-bridge-shim.cjs`：用于 SEA 构建与源码级冒烟的 JavaScript 中间产物。
- `dist/codex-remote-bridge-<version>-<target>.vsix`：Controller 平台包。
- `dist/codex-remote-bridge-executor-<version>-linux-x64.vsix`：版本化 Executor 包。
- `dist/codex-remote-bridge-executor.vsix`：Controller 内嵌 Executor 副本。

`dist/` 只保留当前版本产物，不作为历史归档。

## 文档

- [实施状态](https://github.com/RaraAlu/remote_codex/blob/main/docs/implementation-status.md)
- [兼容矩阵](https://github.com/RaraAlu/remote_codex/blob/main/docs/compatibility.md)
- [安全边界](https://github.com/RaraAlu/remote_codex/blob/main/docs/security-notes.md)
- [升级跟进与发布门禁](https://github.com/RaraAlu/remote_codex/blob/main/docs/upgrade-tracking.md)
- [人工验收记录](https://github.com/RaraAlu/remote_codex/blob/main/docs/manual-acceptance-backlog.md)
- [验收记录目录](https://github.com/RaraAlu/remote_codex/tree/main/docs/acceptance)
- [0.3.0 系列历史 README](https://github.com/RaraAlu/remote_codex/blob/main/docs/archive/README-0.3.0.md)

根 README 只描述当前产品、当前支持边界和活动 TODO。版本演进、历史计划、验收流水和
关闭的待办保存在不可覆盖的归档与验收文档中。

## TODO

### 统一工具代理与远程位置透明

- 为当前 app-server 建立统一工具路由清单，按实际运行结果标记 Bridge 动态工具、远程
  MCP、本机 MCP、App、Connector 和 Web 工具的执行位置、工作区绑定、能力与降级原因；
  Shim 必须把这份清单交给 thread 和每轮模型上下文，不能再依据工具是否包含
  `target` / `rootId` 猜测执行位置。
- 将现有 `mcp-proxy` 收敛为统一代理入口，以稳定的路由描述和 Provider 接口承接
  `stdio`、Streamable HTTP、SSE 与本机/云端 passthrough。Codex 侧使用统一调用路径，
  传输差异只留在代理内部；未知工具参数不得被猜测或改写。
- 保留安全自动路由，并增加显式远端路由配置，支持结构化 executable/argv、受约束的
  远端 `cwd`、远端环境变量或凭据引用和显式适配器。不得复制、记录或回传本机 Token、
  MCP `env`、本机 `cwd` 或进程环境快照。
- HTTP/SSE Provider 必须复用活动 VS Code Remote SSH transport，不建立第二条 SSH
  认证链路；实现远端请求、会话和流式响应转发，以及来源限制、大小上限、超时、取消、
  断线恢复、凭据脱敏和窗口关闭后的资源回收。
- App、Connector、Web 和必须留在本机或云端的 MCP 保持原执行位置，但应能用于远程
  thread；涉及路径或项目语义的差异只能由显式适配器处理，不能伪造本机路径、远端路径
  或工作区 URI。
- 在仓库内提供同时覆盖 stdio、Streamable HTTP 和 SSE 的统一 MCP Fixture，以同一组
  工具契约验证 `initialize`、`tools/list`、`tools/call`、流式结果、失败、超时、取消、
  断线和清理；真实第三方兼容性至少使用 Codegraph 验证，不依赖安装大量外部 MCP。
- 按统一代理核心、远端 Provider、模型位置透明和跨平台收口拆成独立可验证目标。每个
  目标完成定向测试、`npm run check`、对应产物构建、真实 Remote SSH 审计和独立提交后
  才进入下一目标。
- 退出条件：Codex 在本地与 Remote SSH thread 中可以用相同方式选择并调用全部已配置
  工具；工作区、进程和项目文件操作实际落在授权远端根，本机或云端工具保持可用且位置
  明确；所有工具都有可诊断的有效路由或真实不兼容原因，Linux x64 与 Windows x64
  分别完成发布门禁，不再因参数形状或缺少 `target` / `rootId` 产生模型侧误拒绝。

### Codex 原生上下文入口

- 在 VS Code 资源管理器右键菜单增加“添加到 Codex 上下文”，同时覆盖普通本地窗口与
  Remote SSH 工作区，支持单文件、多文件、单文件夹和多文件夹。
- 文件夹按稳定顺序展开和去重，遵守工作区排除规则、忽略文件、符号链接边界、二进制与
  大小上限；超量输入必须在读取或发送前提示，不得静默形成不完整上下文。
- 支持把一个或多个本机文件夹拖入 Codex 输入区，并保留官方现有的单文件和多文件拖放。
- Remote SSH 窗口支持把本机文件拖入当前 Codex 上下文。上下文必须保留
  `local` / `remote` 来源身份，不能把本机路径解释为远端路径，也不能伪造或替换
  VS Code 工作区 URI。
- 优先使用官方命令、VS Code 命令参数和 app-server 协议。若文件夹拖放必须修改官方
  Webview，则实现独立、可关闭、可恢复的兼容适配层：按实际资产结构探测能力，幂等
  备份和恢复，升级后失败关闭并保留 Bridge 核心功能，诊断中明确报告补丁状态。
- 自动化覆盖选择集合、文件夹展开、去重、排除、大小限制、路径来源和升级后失败关闭；
  实机覆盖本地单/多文件、本地单/多文件夹、本机文件夹拖放、Remote SSH 远端资源右键，
  以及 Remote SSH 窗口中的本机文件拖放。
- 退出条件：所有入口把内容加入当前活动 thread，重复资源只出现一次，本机与远端同名
  文件保持可区分；窗口重载、官方扩展升级和功能撤销不破坏官方 Codex UI 或 Bridge
  主链路。

### Windows x64 与 0.4.0

- 为 Windows 设计可回滚且不破坏 npm 升级的普通 `codex` 同名自动入口，同时管理
  `codex`、`codex.cmd` 与 `codex.ps1`，验证唯一同目录会话自动附着、无匹配会话透传、
  歧义失败关闭、停用恢复和 npm 升级恢复；当前已验证的显式入口保持
  `codex-vscode.exe`。
- 处理官方扩展 `26.727.40816` 在 Windows UI Extension Host 中每 5 秒把 Remote SSH
  POSIX 根当作 `\\root\\...` 本机路径监视并产生 `git-init-watcher ENOENT` 的问题；
  不得通过伪造工作区 URI 规避，退出条件是重复警告消失且远端 Git/文件/命令链路不退化。
- 在 Windows x64 原生环境完成 Extension Host、Shim、官方任务、本地窗口与 Remote SSH
  主链路验证，独立记录 Windows 日志、审计和量化结果，不以跨平台构包替代实机证据。
- Windows 验证通过并完成统一发布门禁前不发布 `0.4.0`。

### 0.4.0 之后：自动安装终端捕获 Skill 与多终端补全

- 优先复用经过安全审计、许可证核验和版本固定的开源终端捕获 Skill；首个候选为 MIT 许可的
  [`popbones/tmux.skill`](https://github.com/popbones/tmux.skill)，使用其持久 tmux 会话、命令发送
  和 pane 输出捕获能力，不重复实现已有的 Unix/tmux 工作流。
- 在用户明确同意后自动安装、升级或卸载相关 Skill，记录来源、固定提交、内容哈希和许可证，
  提供离线失败降级与回滚；自动 Hook 必须经过 Codex 原生信任审查，不得静默修改全局配置、
  自动信任第三方脚本或绕过 Hook 信任检查。
- 在复用 Skill 不能覆盖的范围内补全 PowerShell、`cmd.exe`、Git Bash、WSL/Linux shell 和
  VS Code 集成终端，统一会话身份、工作目录、命令、标准输出、标准错误、退出码、生命周期及
  本地/Remote SSH 来源模型，并提供可配置、可关闭、可恢复的自动捕获 Hook。
- 退出条件：完成 Skill 自动安装、固定版本升级、卸载、回滚和供应链校验测试；各类受支持终端
  均完成自动捕获、手动触发、禁用与恢复测试，并在本地窗口和 Remote SSH 窗口验证来源标记、
  输出完整性、退出码、敏感信息脱敏、交互兼容性和失败降级行为。
