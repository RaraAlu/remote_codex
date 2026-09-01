# Codex Remote Bridge

## 概览

Codex Remote Bridge 让官方 Codex VS Code 扩展及其内置 app-server 保持在本机运行，
同时把经过授权的项目操作路由到当前 VS Code Remote SSH 工作区。默认链路复用 VS Code
已经建立的远程连接，不读取 SSH 密码或私钥，也不会在远端启动 Codex。

> 当前源码版本为 `0.3.79` 候选。已取消 Bridge 自定义的资源管理器右键添加入口和远端
> 快照附件；官方输入区的原生 `@` 文件搜索通过当前 VS Code Remote SSH 工作区查询，
> 不访问本机控制目录。可选兼容层不要求用户按住 `Shift`：VS Code Explorer 拖放转换为
> 当前光标处的原生 `@` 引用；无论来自 VS Code Explorer 还是系统文件管理器，文件和
> 目录都采用同一表示。启用兼容层时可一次性同意接收之后明确拖入的本机资源；
> Remote SSH 会话始终只有一个远程项目主根。本机拖入项按当前 Codex thread 单独绑定：
> 专用资源 ID 对文件和目录保持只读，但 `0.3.77` 的本机最大权限意味着该 ID 不再是文件
> 系统安全边界，Core 仍可直接访问任意本机路径。Linux x64
> Remote SSH 已验证单次 14 个本机资源可全部进入原生 `@` 输入，不再受旧次级根数量上限
> 阻断；会话声明、跨对话隔离和删除清理仍按文末 TODO 完成安全验收。
> Windows 已完成 npm 三种 CLI wrapper 的安全接管、普通
> `codex` 自动附着、显式 `codex-vscode.exe` TUI、外部 MCP、历史 thread 同步、无 rollout
> 冷启动降级、停用恢复和 npm 升级恢复实测；官方 Remote SSH git watcher 的路径误判
> 与重复告警也已完成可逆兼容修复和远端只读链路实测。Shim 现已把统一工具路由清单
> 注入 thread 和每轮上下文，执行位置不再按 `target` / `rootId` 参数形状猜测；MCP 家族以
> `route-configured` 区分“路由已配置”和“具体工具可调用”；远端前台命令现以快速确认和
> 异步有序事件回传避免跨 Extension Host 重入等待，连续五次实测均在 `177–299 ms` 完成。
> 外部 MCP 使用每连接唯一身份、主 app-server 就绪后发布网关，并对一次性冷初始化停滞
> 进行有界重试；Windows 实机连续初始化为 `10 / 4 / 4 ms`，真实 MCP 调用无错误。
> 官方扩展现在固定启动稳定的本机 launcher，由 launcher 按当前 Extension Host 代际选择
> 并校验内容寻址 Shim；普通 Controller/Shim 更新实测只需一次用户重载即可运行新 Shim，
> 不会再因 `chatgpt.cliExecutable` 内容路径变化触发第二次窗口重载。
> Remote SSH 冷启动期间会明确区分“窗口已打开”和“Remote Extension Host 已响应”：
> 状态栏、日志、审计和诊断记录 Executor 能力探测阶段、次数与耗时，不会提前伪报
> `ready`。
> 官方 Codex 与内置 Copilot Chat 固定在本机 UI Extension Host，避免 AI 界面扩展抢占
> 远端 Extension Host；Bridge 会逐项备份并可恢复原有扩展位置设置。
> 外部会话描述符同时绑定 Shim PID、真实进程启动时间和可执行文件路径；会话发现会清理
> 已退出或 PID 已被复用的旧描述符，同时保留仍由匹配 Shim 进程拥有的活动会话。
> 完整双平台
> 门禁仍待处理。
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
- 官方扩展只配置稳定 launcher 路径；Controller 原子发布当前 Extension Host 代际、Shim
  路径和完整 SHA-256，launcher 校验后再启动对应内容寻址 Shim。
- Remote Executor 是远端 Workspace 扩展，只执行结构化、受根目录约束的操作。
- 默认 `vscode-remote` 模式复用活动 Remote SSH transport；`openssh` 仅作为显式回退。
- 官方扩展、内置 Codex、Controller、Shim 和 Executor 组成兼容集合，但版本值只用于
  诊断和回归触发，不作为运行时接纳条件。

## 主要能力

- 自动识别单根 Remote SSH 工作区；每次初始化核对远端实际包版本，不一致时通过活动
  VS Code Remote SSH transport 部署当前 Controller 内嵌的配套 Remote Executor 并重载。
- 远程读取、目录树、字面搜索、Git 状态和结构化命令执行。
- 基于 SHA-256 的双端安全写入、精确补丁、重命名和删除。
- 远程命令和重要写操作也固定自动放行，不显示 Bridge 审批界面。
- 运行中取消、进程组终止、有界幂等账本和断线结果查询。
- 受控后台任务的启动、状态、增量日志和取消。
- 远程文件定位、选区、资源 URI 和 Diff 映射。
- 每轮自动采集当前 Remote SSH 编辑器文件或非空选区作为 IDE 背景。
- 符合安全条件的 stdio MCP 可通过当前 VS Code Remote 通道在远端运行。
- 本地 Codex CLI 可附着和介入活动 VS Code Codex thread。
- 普通本地窗口按当前唯一文件工作区过滤任务列表；Remote SSH 窗口按主机和远程根隔离。
- 本机拖入资源不再写入项目根配置，而是按当前 Codex thread 形成独立只读引用；不同对话
  的引用记录和删除生命周期仍隔离，但本机最大权限允许 Core 绕过引用直接访问同一路径。
- Remote SSH 模式默认直接向 Codex 提供本机 VS Code 用户拥有的最大文件系统和进程权限，
  不再设置本机路径授权、目录选择或逐根审批。模型既可使用本机 Core 文件/Shell 能力，也可
  通过 `local-full-access` 根的 `workspace_*` 结构化工具访问整个本机文件系统。
- 本地结构化审计不记录文件正文、密码、私钥、Token 或完整环境变量。
- 可选的原生 Codex 拖放接收面通过 VS Code Workbench 外层接收 Explorer 与系统文件
  管理器路径，再调用官方 `chatgpt.addFileToThread`。Bridge 为所有受管拖放路径携带标记，
  配套 Webview 补丁统一在当前光标处插入原生 `@` 引用；普通未标记的官方命令仍保持官方
  行为。Remote SSH 对话中的本机文件和目录会在提交该 `@` 引用时绑定到当前 thread；
  文件不扩大到父目录，目录只允许读取自身子树，未拖入路径不会被预先开放。随后由本地
  `workspace_*` 只读工具分析。扩展激活会按当前 VS Code
  与官方 Codex 资产组合自动检查兼容性；首次可安全启用时只弹出一次明确确认，确认后
  自动请求所需系统文件权限并重载窗口。Bridge 会为 Workbench、
  `product.json` 和官方 Webview 资产保存带 SHA-256 的可恢复原件。VS Code 或官方 Codex
  正常升级替换旧资产后，Bridge 会以安装身份、当前产品校验和、代码能力和旧备份共同确认
  升级边界，清理过期托管状态并对新资产重新请求一次兼容确认；同版本外部改写仍失败关闭。

## 支持边界

- 本地 Controller 目标为 Linux x64 或 Windows x64；两者必须在各自原生平台构建和验收。
- 远端目标为 VS Code Remote SSH 打开的 Linux x64 工作区。
- 自动初始化只接受当前窗口中唯一的远程工作区根，不猜测多根工作区。
- 默认模式不会建立第二条 SSH 认证链路。
- Remote SSH 对话中的本机拖入资源只支持默认 `vscode-remote` transport；显式 OpenSSH
  回退没有 Controller 本地资源通道，因此会失败关闭。
- 默认 `vscode-remote` 模式不限制本机 Core 文件和命令能力；其实际边界就是本机 VS Code
  用户的操作系统权限。`workspace_*` 结构化整文件写入仍保持 1 MiB、哈希和原子写边界，
  但本机 Shell 不受该结构化限制。
- `remote_exec` 限制启动目录但不是远端文件系统沙箱；最大权限模式会直接执行完整命令。
- Remote SSH 会话固定使用本机 `full-access`，不会再显示本机路径或命令审批。
- Windows、Linux 和 OpenSSH 的构包或运行结果不能互相替代。

当前组件矩阵和已验证范围见
[兼容矩阵](https://github.com/RaraAlu/remote_codex/blob/main/docs/compatibility.md)，
完整安全说明见
[安全边界](https://github.com/RaraAlu/remote_codex/blob/main/docs/security-notes.md)。

## 安装与启动

### 安装现成 VSIX

1. 获取与本地 VS Code 平台匹配的 Controller VSIX：
   - Linux x64：`codex-remote-bridge-<version>-linux-x64.vsix`
   - Windows x64：`codex-remote-bridge-<version>-win32-x64.vsix`
2. 在 VS Code 扩展视图右上角菜单选择 `Install from VSIX...`；也可在本机终端执行：

   ```bash
   code --install-extension "/absolute/path/to/codex-remote-bridge-<version>-<target>.vsix" --force
   ```

   Controller 必须安装到本机 UI Extension Host，不要在远端主机上单独执行安装命令。
3. 使用 VS Code Remote SSH 打开唯一一个远程工作区根目录。
4. 等待 Bridge 自动配置、部署 Executor，并在必要时完成一次窗口重载。
   普通 Controller/Shim 更新最多需要这一次用户重载；只有 Remote Executor 首装或升级
   才保留独立的远端窗口自动重载。首次进入新的 Remote SSH 主机/根时，如果官方 Codex
   早于窗口会话配置启动，Bridge 会记录该组合并自动重载一次，让 app-server 重新附着；
   同一组合最多执行一次，失败时不会循环重载。
5. 状态栏可能先显示远端 transport 已就绪但仍在等待 Codex；只有 Shim 进程存活且
   官方 app-server 完成 `initialize` 后才显示 `Codex: local -> <host> (ready)`。
6. 运行 `Codex Bridge: Run Diagnostics`，确认远端身份、工作区根和
   `remote.codexInstalled=false`，并检查 `shimStarted`、`appServerInitialized`、
   `shimLastExitCode` 与 `appServerLastError`。
7. 在官方 Codex 面板创建任务，并通过日志和审计确认项目操作位于远端。

### 从源码打包并安装

在目标本机平台使用 Node.js 20 或更高版本执行：

```bash
npm ci
npm run check
```

`npm run check` 会完成类型检查、全部自动化测试、构建、Shim 冒烟和当前平台 VSIX 打包。
Linux x64 随后执行：

```bash
VERSION=$(node -p "require('./package.json').version")
code --install-extension "dist/codex-remote-bridge-${VERSION}-linux-x64.vsix" --force
```

Windows x64 PowerShell 随后执行：

```powershell
$version = node -p "require('./package.json').version"
code --install-extension "dist/codex-remote-bridge-$version-win32-x64.vsix" --force
```

安装后执行一次 `Developer: Reload Window`。正式发布候选仍须在 Linux x64 和 Windows x64
原生构建机分别生成 stage，再按“开发与验证”一节收集和校验双平台产物。

### 本机最大权限与远端下载

Remote SSH 配置完成后无需额外授权：新 thread 会固定为本机 `full-access`，并同时获得
`local-full-access` 根。需要把远端文件下载到本机时，直接给出本机绝对目标路径；模型可
组合远端 `workspace_*` 与本机文件/Shell 能力完成复制和校验。Bridge 不再要求打开另一个
本地 VS Code 窗口，也不会弹出目录选择器或为每个路径建立授权记录。该模式等同于让当前
Remote SSH Codex 继承本机 VS Code 用户可访问的全部文件和进程能力，使用者必须自行承担
误删、覆盖、凭据读取和执行任意本机命令的风险。

### 启用和使用原生拖放

1. 扩展激活后会自动检查当前 VS Code 与官方 Codex 资产。检测到兼容且尚未启用的原生
   拖放接收面时，Bridge 只对该资产组合弹出一次确认；该确认同时允许 Remote SSH 窗口
   自动授权用户之后明确拖入的本机文件或目录。确认后自动请求所需系统文件权限，
   Linux 系统安装会出现 polkit 授权框，补丁成功后窗口自动重载。拒绝或关闭确认后不会
   对同一资产组合重复打扰，可随时从命令面板执行
   `Codex Bridge: Enable Native Codex Drop Surface` 手动重试。VS Code 或官方 Codex 扩展
   升级后会重新探测；经产品身份和当前校验和确认的正常升级会丢弃旧托管状态，再对新资产
   请求一次确认；无法证明属于升级的哈希或代码形状变化会拒绝修改。
2. 把 VS Code Explorer 或系统文件管理器中的文件、目录直接拖入官方 Codex 对话区域。
   所有 Bridge 捕获的拖放都在当前 Composer 光标处生成一个原生 `@` 引用，不需要按
   `Shift`，也不按拖动来源切换为附件。
3. Remote SSH 窗口中的远端 Explorer 资源仍使用唯一远端主根。本机资源先暂存，只有在
   对应原生 `@` 随 turn 提交时才绑定到该 Codex thread；文件能力精确到单文件，目录能力
   只覆盖其子树，均为只读，不写入 `roots`、不复制到远端，也不与其他对话共享。这里没有
   本地次级根数量上限；单次拖放载荷仍受现有输入资源数量和传输大小边界约束。
4. 删除 Codex 对话会同步清理该 thread 的本机资源绑定。停用或卸载前先执行
   `Codex Bridge: Disable Native Codex Drop Surface`，让 Bridge 校验并恢复受管的
   Workbench、`product.json` 和官方 Webview 资产。

关闭 `codexRemoteBridge.autoInitialize` 后，可以使用 Configure 和 Start 命令手动
控制。停用前应执行 `Codex Bridge: Restore Official Codex Settings`，恢复 Bridge
接管过的官方设置。

Bridge 会把 `openai.chatgpt` 与 VS Code 内置的 `GitHub.copilot-chat` 固定到本机 UI
Extension Host，避免它们占用远端 Extension Host；两项 `remote.extensionKind` 原值分别
备份，恢复命令不会覆盖其他扩展后来增加的映射。

## 常用命令


| 命令                                              | 用途                               |
| ------------------------------------------------- | ---------------------------------- |
| `Codex Bridge: Configure Current Remote`          | 保存当前 Remote SSH 主机和工作区根 |
| `Codex Bridge: Start`                             | 启动或重新连接 Bridge              |
| `Codex Bridge: Stop`                              | 停止当前 Bridge 会话               |
| `Codex Bridge: Run Diagnostics`                   | 显示脱敏后的组件、连接和能力状态   |
| `Codex Bridge: Show Audit Log`                    | 打开本地审计日志                   |
| `Codex Bridge: Add Remote File to Next Turn`      | 为下一轮显式加入当前远程文件       |
| `Codex Bridge: Add Remote Selection to Next Turn` | 为下一轮显式加入当前远程选区       |
| `Codex Bridge: Enable Automatic CLI Integration`  | 启用本地 Codex CLI 自动附着        |
| `Codex Bridge: Disable Automatic CLI Integration` | 停用 CLI 集成并恢复托管入口        |
| `Codex Bridge: Restore Official Codex Settings`   | 恢复 Bridge 接管前的官方设置       |
| `Codex Bridge: Enable Native Codex Drop Surface`  | 启用 Codex 面板原生拖放接收面      |
| `Codex Bridge: Disable Native Codex Drop Surface` | 校验并恢复原始 Workbench 资产      |

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

启用自动 CLI 集成后，无参数 `codex` 只会自动附着工作目录与当前目录完全一致的活动
VS Code thread。当前目录没有匹配会话时透传官方 Codex CLI，不会被其他工作区的活动
会话拦截；同一目录存在多个匹配会话时失败关闭，可使用：

```bash
codex-vscode --session-pid <pid>
```

Windows 只在 PATH 解析到同一 npm 目录中的 `codex`、`codex.cmd` 和 `codex.ps1` 三个普通
文件时接管完整 wrapper 集合。原始文件以相邻隐藏备份保存；npm 覆盖 wrapper 后，下一次
扩展初始化会刷新备份并恢复接管。停用集成会原样恢复仍由 Bridge 管理的 wrapper；若文件
已被其他程序修改，则保留现状而不覆盖。显式入口保持为
`%LOCALAPPDATA%\codex-remote-bridge\bin\codex-vscode.exe`。

介入能力包括列出对话、读取完整 turn、发起新 turn 或 steer，以及中断运行中的 turn。
已经启动的旧 CLI 进程不能热切换 app-server，需要退出后重新启动。停用集成后也应
重新启动 CLI，使恢复后的官方入口生效。

## 开发与验证

```bash
npm ci
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

### Codex 原生上下文入口

- `0.3.79` 候选修复窗口重载后旧官方 app-server 遗留并占用 thread writer 的问题。Shim
  会在 v3 会话描述符中记录官方 app-server 的 PID、启动时间和真实可执行路径；新
  Extension Host 激活时只清理 Shim 已死亡且 app-server 身份仍精确匹配的旧实例，PID
  复用、无法确认身份和其他 CLI/App 进程均失败关闭。旧 v2 描述符只通过其私有 upstream
  token 命令行精确迁移。退出条件是在真实 Linux 本地窗口运行一个完整 turn 后重载，旧
  app-server 自动退出或被新代际清理，恢复同一 thread 不再出现 `already has an active
  writer` 或“已在另一个应用中打开”，Bridge 审计记录 `app_server.stale_cleanup`，当前
  app-server 的 `readyz`、`healthz` 保持 200；同时保留独立 CLI 与 ChatGPT App 进程。
- 修复 Linux 多个 POSIX `codex` 入口的并存管理：当前不同 VS Code Extension Host 的
  `PATH` 会分别命中 `~/.local/bin/codex` 与 NVM 下的 `codex`，而 v2 集成元数据只保存一个
  `automaticLauncher`，导致后激活窗口恢复前一个入口并形成 last-writer-wins；未被当前
  Host 命中的入口会绕过 Bridge，启动独立 app-server。退出条件是安全保存并管理全部已识别
  的符号链接入口，停用时逐项恢复原目标，并在真实 Linux 本地窗口中同时运行官方 VS Code
  Codex、普通 `codex` CLI 和 ChatGPT App：空闲界面可各自新建独立对话，显式附着时可共享
  目标 thread，任一长 turn 不得被误报为另一个表面阻塞，日志与审计能区分独立和附着会话。
- 核对官方 IDE 背景开关与 Bridge 隔离：当前 `openai.chatgpt@26.727.40816` 的
  `composer-auto-context-enabled` 用户状态为关闭，现有本地 rollout 因而记录
  `ide_context=null`。通过官方 `/ide` 重新开启后，分别验证普通本地窗口的活动文件、
  打开标签和选区，以及 Remote SSH 窗口的 Bridge 自动编辑器上下文；退出条件是本地
  原生上下文恢复、远端 `editor_context.inject` 成功，且 Bridge 从不改写该官方开关。
- 跟踪官方 Codex Diff 回归：`openai.chatgpt@26.727.40816` 在两个普通本地窗口打开
  变更审查时均于 `editor-diff-page` 触发错误边界，而 Bridge 当时处于 idle；已确认 Shim
  下游收到的是可由官方解析器正常解析的标准 `turn/diff/updated`，且本地空配置不改写
  该通知。退出条件是完成禁用 Bridge 后的重载对照，并在官方修复版或必要的兼容适配后
  通过普通本地窗口与 Remote SSH 窗口的真实 Diff 审查。
- 当前候选已把官方输入区的 `fuzzyFileSearch` 一次性请求及三个会话请求显式代理到
  当前 Remote SSH 工作区；未知 `fuzzyFileSearch/*` 仍失败关闭。退出条件是重载真实
  Remote SSH 窗口后，原生 `@` 搜索能返回并选择远端文件、搜索完成态不再卡住，实际 turn
  能读取该文件，同时审计出现 `fuzzy_file_search.session_update` 且不再出现对应的
  `local_core_request.blocked`。
- Workbench 与官方 Codex Webview 兼容层在扩展激活时自动探测，并对每组 VS Code/Codex
  资产提供一次明确确认；只有用户确认后才请求 polkit 或修改安装目录，补丁成功后自动
  重载，拒绝后同一资产组合不再重复提示。Webview 补丁只转换带 Bridge 受管标记的拖放，
  Explorer 与系统文件管理器捕获结果均使用该标记，普通未标记的
  `chatgpt.addFileToThread` 仍保持官方语义。
  未知代码形状、备份缺失、哈希不符和外部修改均失败关闭。当前 Linux 本地与 Remote SSH
  的统一 `@` 拖放
  已于 2026-08-10 完成实机验证；`0.3.73` 的自动权限请求、成功后自动重载、欢迎页无焦点
  降级和 Remote SSH 窗口重载回归也已完成。`0.3.75` 已把本机拖入项从全局
  `local/secondary` 根改为当前 Codex thread 的只读资源能力；2026-08-10 在真实 Remote SSH
  窗口连续两轮拖入 14 个互不依赖的本机资源，均完成 `stage_drop` 和原生 `@` 插入，不再
  出现次级根数量错误。剩余退出条件是在提交本机文件和目录后确认
  `conversation_resource.claim`，另一个对话不继承该引用 ID，配置与诊断不得因拖放增加
  额外根（固定的 `local-full-access` 除外），远端项目根仍只有唯一主根；删除对话后出现
  `conversation_resource.delete_thread`。专用资源的根外、写入和 Git 负测不再作为整体本机
  隔离声明，因为 `0.3.77` 明确开放本机 Core 最大权限。还需执行禁用与逐字节恢复验收，
  并在 VS Code 或官方扩展升级后重新探测和回归，不能沿用旧版本放行结果。2026-08-13
  升级到 VS Code `1.133.0` 与 `openai.chatgpt@26.5810.41047` 后已复现旧托管元数据被误判
  为冲突、官方 Composer 新增第六参数而导致统一 `@` 拖放未启用；`0.3.76` 候选已增加
  可验证升级状态迁移和六参数能力探针。退出条件是安装该候选后只出现一次新资产确认，
  且 VS Code 模态确认完全关闭后再显示 polkit 授权框，完成权限请求与自动重载；Bridge
  输出不再记录 `workbench=conflict`、`inlineMention=conflict` 或因 GNOME modal grab
  冲突导致的 `Request dismissed`，本地窗口及 Remote SSH 窗口从 Explorer 和系统文件管理器直接
  拖入文件/目录均在当前光标生成唯一 `@` 且 turn 可读取，并完成禁用后的逐字节恢复。
  2026-08-31 在 VS Code `1.135.0`、官方扩展 `26.5825.51511` 和 Bridge `0.3.79` 的
  本地窗口重载后再次出现拖放无响应；Bridge 日志只记录
  `layout.integration result=already-repaired`，实际拖动没有任何 `phase.workbench.drop.begin`
  或后续捕获事件。退出条件增加：重新核对当前 Workbench 捕获入口与官方 Webview 资产，
  修复后从 VS Code Explorer 和系统文件管理器分别连续拖入文件与目录至少 3 次，均产生
  完整捕获序列和唯一原生 `@`，并在再次重载后保持有效。
- `0.3.77` 候选按当前产品决策取消全部本机路径授权机制：Remote SSH 配置会直接加入覆盖
  本机文件系统根的 `local-full-access`，Core 权限固定为 `full-access`，本机文件、Shell、
  进程和服务端审批请求不再被 Bridge 阻断；Core 审批请求由 Shim 自动接受，远端命令、
  后台任务和工作区写入也不再读取旧 thread 的审批模式。2026-08-25 首轮 bitahub 实测在
  完全访问 UI 下仍出现一次 `remote_exec` 允许提示，审计证明旧审批跟踪器返回
  `automatic=false`；候选已改为一律自动放行。退出条件是安装候选并重载后，无任何目录选择、
  本机/远端命令或文件授权提示，当前对话即可读取和写入
  `/home/zkbot/work/train/Teleopit`、执行本机命令，并从
  `/root/Bote_Teleopit` 下载预期 34 个文件后核对相对路径与 SHA-256；诊断应显示
  `localExecution="allow"`、`local-full-access` 和 `fullLocalAccess.accessible=true`，同时
  回归远端命令仍在远端主根执行。该模式明确接受最大本机权限风险，不再以根外拒绝、撤销
  或本机 Core 阻断作为安全保证。

### Windows x64 与 0.4.0

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
