# Codex Remote Bridge

这是 `docs/codex-vscode-remote-bridge-requirements.md` 的可行性验证实现。目标是让官方
Codex VS Code 扩展和 Codex app-server 留在可联网的本地 Ubuntu，同时只通过
OpenSSH 访问离线远程 Ubuntu 工作区。

> 当前版本是只读技术原型，不是完整 MVP。不要用它执行写文件、训练或其他有副作用
> 的生产操作。

## 当前实现

- Bridge 扩展固定声明为 VS Code `ui` 扩展，并提供需求中的 6 个命令。
- 单根 Remote SSH 工作区打开后自动识别主机和根目录、保存配置并连接，无需手动启动。
- 首次接管官方 Codex 设置时自动重载一次；后续打开工作区直接进入 `ready`。
- `chatgpt.cliExecutable` 虽为全局设置，但 Shim 仅在对应 Remote SSH 扩展宿主带有会话
  配置时接管；普通本地窗口完全透传官方 Codex。
- 每个工作区首次就绪时把 Codex Webview 恢复到默认右侧栏，修复旧布局中的灰色面板。
- 修改 `chatgpt.cliExecutable` 和 `remote.extensionKind` 前保存原值，并提供恢复命令。
- 默认命令不在 VS Code 的 `PATH` 时，自动探测 `~/.local/bin/codex` 等常见本地路径。
- CLI Shim 代理 app-server JSONL，固定本地只读控制目录，并注入实验协议能力。
- 新线程注入远程读取、目录列出、文本搜索和 `git status` 动态工具。
- OpenSSH 执行器使用结构化 `argv`、严格主机密钥校验、连接超时、取消和输出上限。
- 直连主机可单独配置 SSH 用户、端口和可选 IdentityFile；私钥内容不由 Bridge 读取。
- 同一 `connectionId` 使用受限 ControlMaster 复用，并在停止时显式关闭。
- 路径同时经过词法限制和远端 `realpath` 校验，符号链接不能逃逸工作区。
- 远端缺少 `rg` 时自动使用不跟随目录符号链接的 GNU `grep` 搜索。
- SSH 子进程只继承必要环境变量，不继承 Codex、OpenAI 或其他应用凭据。
- 未知 app-server 服务端请求默认拒绝；操作审计日志只保存在本地并结构化脱敏。
- 协议子集由本机 Codex `0.144.3` 生成，运行时要求精确版本匹配。

## 尚未实现

- 哈希保护的远程写入、补丁、删除和重命名。
- 通用远程命令、流式训练输出、审批绑定、幂等键和断线后结果确认。
- 官方 Codex 审批 UI 与 Bridge 写入/命令策略的端到端接入。
- 对 Codex Core 内置本地 Shell 工具的执行前硬阻断。
- 在目标 Remote SSH 主机和 MimicLite 仓库上的完整 P0 验收。

最后两项是进入阶段 C 前的安全门槛。当前 Shim 会把 app-server 放在无项目文件且
不可写的本地控制目录，并通过指令要求只用远程工具，但这不能替代 Core 层的强制
路由控制。

## 开发与自测

```bash
npm install
npm run check
```

`npm run check` 依次执行 TypeScript 类型检查、单元/集成测试、扩展和 Shim 构建、
本地窗口透传与 Remote SSH 窗口初始化、线程列表和线程创建冒烟测试，以及 VSIX 打包。

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

- `dist/codex-bridge-shim.cjs`
- `dist/codex-remote-bridge.vsix`

重新生成匹配当前 Codex 版本的协议子集：

```bash
npm run protocol:generate
```

生成后必须重新运行 `npm run check`，并更新兼容矩阵。

## 试用流程

1. 安装 `dist/codex-remote-bridge.vsix` 到本地 VS Code。
2. 用 Remote SSH 打开单个远程工作区。
3. Bridge 自动保存当前主机和根目录；首次接管官方设置时窗口自动重载一次。
4. 等待状态栏显示 `Codex: local -> <host> (ready)`。
5. 运行 `Codex Bridge: Run Diagnostics`，确认本地扩展宿主、官方设置、远端身份和
   `remote.codexInstalled=false`。
6. 只进行远程读取、目录列出、搜索和 `git status` 验证。
7. 停用原型前执行 `Codex Bridge: Restore Official Codex Settings`；该命令同时关闭
   `codexRemoteBridge.autoInitialize`，避免重载后再次接管。

自动流程仅在 `codexRemoteBridge.autoInitialize=true`、当前窗口为 Remote SSH 且恰好
打开一个远程根目录时运行。关闭该设置后仍可使用 Configure 和 Start 命令手动控制。
普通本地工作区即使同时打开，也不会读取远程 Bridge 配置或重写 app-server 消息。

本地配置默认位于 `~/.config/codex-remote-bridge/config.json`，审计日志默认位于
`~/.local/state/codex-remote-bridge/audit.jsonl`。Remote SSH 窗口会额外创建按本地
Extension Host PID 隔离的会话配置；配置不保存密码、私钥或 Token。

更多边界与验收信息见 `docs/implementation-status.md`、`docs/compatibility.md` 和
`docs/security-notes.md`。
