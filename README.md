# Codex Remote Bridge

## 概览

Codex Remote Bridge 让官方 Codex VS Code 扩展及其内置 app-server 保持在本机运行，
同时把经过授权的项目操作路由到当前 VS Code Remote SSH 工作区。默认链路复用 VS Code
已经建立的远程连接，不读取 SSH 密码或私钥，也不会在远端启动 Codex。

> 当前源码版本为 `0.3.43` 候选。Linux x64 / Remote SSH 已有实机证据，Windows x64
> 原生验证尚未完成；在双平台门禁完成前不发布 `0.4.0`，也不扩大支持声明。

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

- 自动识别单根 Remote SSH 工作区并部署匹配的 Remote Executor。
- 远程读取、目录树、字面搜索、Git 状态和结构化命令执行。
- 基于 SHA-256 的双端安全写入、精确补丁、重命名和删除。
- 远程命令和重要写操作沿用官方 Codex 权限模式及审批界面。
- 运行中取消、进程组终止、有界幂等账本和断线结果查询。
- 受控后台任务的启动、状态、增量日志和取消。
- 远程文件定位、选区、资源 URI 和 Diff 映射。
- 每轮自动采集当前 Remote SSH 编辑器文件或非空选区作为 IDE 背景。
- 符合安全条件的 stdio MCP 可通过当前 VS Code Remote 通道在远端运行。
- 本地 Codex CLI 可附着和介入活动 VS Code Codex thread。
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
4. 确认状态栏显示 `Codex: local -> <host> (ready)`。
5. 运行 `Codex Bridge: Run Diagnostics`，确认远端身份、工作区根和
   `remote.codexInstalled=false`。
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

启用自动 CLI 集成后，无参数 `codex` 只会自动附着工作目录与当前目录完全一致的活动
VS Code thread。当前目录没有匹配会话时透传官方 Codex CLI，不会被其他工作区的活动
会话拦截；同一目录存在多个匹配会话时失败关闭，可使用：

```bash
codex-vscode --session-pid <pid>
```

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

- `dist/codex-bridge-shim.exe`：Windows 原生 Shim 构建输出。
- `dist/codex-bridge-shim.cjs`：Linux Shim 构建输出。
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

根 README 只描述当前产品和当前支持边界。版本演进、历史计划、验收流水和关闭的待办
保存在不可覆盖的归档与验收文档中。
