# xj-member 远程只读验收记录

日期：2026-07-16

## 目标

| 项目 | 结果 |
| --- | --- |
| SSH 目标 | `root@xj-member.bitahub.com:42013` |
| ED25519 指纹 | `SHA256:82kdRNO1veVsA0eeO8akGkGsmjlViAUOVKpolYW6ksI` |
| known_hosts | 当前扫描指纹与既有记录一致 |
| 远端主机名 | `bitahub-a20499346669694976219198` |
| 远端 machine-id | `81fb317c23614e3789e25b72aed84401` |
| 远端工作区 | `/root/work/train/MimicLite` |
| Git 分支 | `main`，跟踪 `origin/main` |
| GPU | 4 张 NVIDIA GeForce RTX 4090 |
| 远端 Codex | 未安装，`command -v codex` 非零退出 |
| 远端 ripgrep | 未安装，已走 GNU `grep` 回退 |

用户给出的相对路径 `id_rsa` 在本地工作目录和 `~/.ssh` 中均不存在。验收使用本机
OpenSSH 已有默认密钥配置成功认证；Bridge 未读取或复制任何私钥内容。

## 自动化结果

执行：

```bash
CODEX_BRIDGE_REMOTE_TEST=1 \
CODEX_BRIDGE_TEST_HOST=xj-member.bitahub.com \
CODEX_BRIDGE_TEST_USER=root \
CODEX_BRIDGE_TEST_PORT=42013 \
CODEX_BRIDGE_TEST_WORKSPACE=/root/work/train/MimicLite \
npm run test:remote
```

结果：

- 2 项真实 SSH 集成测试通过，总耗时约 8 秒。
- 执行器单会话验收约 4.5 秒；加入 ControlMaster 前约 43 秒。
- 读取 `README.md`、SHA-256、目录列出、搜索和 `git status` 均来自远端。
- `nvidia-smi` 返回远端 NVIDIA GPU。
- `/etc/passwd` 绝对路径逃逸被拒绝。
- 仓库内 `active-adaptation/venv/mjlab/.venv/bin/python` 最终指向
  `/root/.local/...`，符号链接逃逸被拒绝。
- 假 app-server 发出的 `item/tool/call` 已通过真实 Shim 路由到
  `remote_read_file`，返回远端路径与哈希。

## 未改动证明

验收开始及自动化测试完成时，远端 `git status --short --branch` 显示：

```text
## main...origin/main
?? any4hdmi/
?? scripts/
```

最终独立复核时，远端并发出现了一个新的未跟踪 `logs/` 目录：

```text
## main...origin/main
?? any4hdmi/
?? logs/
?? scripts/
```

其中包含 `setup_mimiclite_env.log` 和 `setup_mimiclite_env.pid`，时间戳持续晚于验收
开始时间，表明远端同时存在环境准备活动。本验收不推断该目录的创建者，也未改动或
删除它。最终 `git diff --quiet` 与 `git diff --cached --quiet` 均返回 0，可确认跟踪
工作树和索引无改动。Bridge 验收命令不含远端写入步骤，也没有安装 Codex 或 `rg`。

## 剩余门槛

- 尚未在真实 Remote SSH VS Code 窗口确认官方 Codex 扩展运行于本地 UI Host。
- 尚未完成当前文件、选区、远程 URI、Diff 和本地同名诱饵文件的界面验收。
- 写入、通用命令及其审批链路仍保持未注入状态。
