# nxbridge

让同一台电脑上的 **Claude Code** 和 **Codex CLI** 互相发消息、平等协作。

你照常跟其中一边说要做什么，两边会按各自擅长的方向自动分工、互相把关，取长补短，不用你在两个窗口之间来回转述。两边仍然是各自的官方 CLI，用各自的登录、模型服务、上下文和权限。nxbridge 自己只在本机传递消息，不调用任何模型，也不把内容发到别处。

## 它能做什么

- **取长补短：** 两边按各自擅长的方向自动分工，较大的任务先商量好再并行，重要的改动互相审查，不用你指定谁来做。
- **自动找搭档：** 同一项目里开着对方的窗口时，问你要不要和它配对；没有时自动在后台启动一个当搭档，有消息就叫醒它干活。
- **后台搭档可以无人值守：** nxbridge 在后台启动的那一边默认全自动运行；崩溃或退出后按原会话自动恢复。
- **消息可靠：** 每条消息都有送达状态，送没送到会如实告诉发信方；结果不明的消息不会自动重发。
- **不动你的模型和权限设置：** 通过两家官方的插件、hooks 和 MCP 接入，安装只添加 nxbridge 自己的插件和工具设置；不改 CLI 本身，不改你的模型、审批和沙箱设置，不装系统服务。

## 需要什么

| 需要 | 说明 |
|---|---|
| Node.js 24～26 | 需要内置的 `node:sqlite`，运行 `node -v` 确认 |
| Claude Code | 已登录 |
| Codex CLI | 已登录，至少 0.164.0 |

已在 Windows 和 WSL（Ubuntu 22.04）上验证。macOS 只在真机上验证过一部分；每次更新时，GitHub Actions 的 macOS 测试机会用官方 CLI 自动跑原生测试。其他 Linux 发行版应该可以用，但没有单独测过。

## 安装

1. 从 [Releases](../../releases) 下载最新的 zip 并解压，在解压出的 `nxbridge-<版本>` 文件夹里打开终端。
2. 安装：

   ```sh
   node nxbridge.mjs setup --dry-run   # 先预演：做完整检查，不写入任何东西
   node nxbridge.mjs setup             # 正式安装
   ```

   安装会把运行文件复制到 `~/.nxbridge`，用两家官方的插件命令装上插件，并放一个 `nxbridge` 命令到你 PATH 里的用户目录。装好后，解压出的文件夹就可以删掉了。

3. 让插件生效：
   - **Claude Code：** 在已打开的窗口里执行 `/reload-plugins`，或新开一个窗口。
   - **Codex：** 新开一个会话，在 `/hooks` 里信任 nxbridge 的 hooks。
4. 想让后台启动的 Claude 全自动运行，需要你本人先在任意终端运行一次 `claude --dangerously-skip-permissions` 并接受提示（只需一次）。
5. 检查：运行 `nxbridge doctor`。

## 使用

在项目目录里打开 Claude Code，像平常一样交代任务就行，一般不用说该谁来做：两边会按各自擅长的方向自动分工，需要时互相审查、交换意见。想指定时直接说，比如“这次让 Codex 审查一下”。

不用自己开 Codex 窗口：需要搭档时，nxbridge 会在后台启动一个 Codex。想看它在做什么，运行 `nxbridge open codex`。

从 Codex 开始也一样，需要时会在后台启动一个 Claude。

常用命令：

| 命令 | 作用 |
|---|---|
| `nxbridge status` | 查看配对和双方状态 |
| `nxbridge doctor` | 检查安装和运行状态 |
| `nxbridge open codex` | 打开后台的 Codex，看它在做什么 |
| `nxbridge pause` / `resume` / `unpair` | 暂停、恢复或解除当前配对 |
| `nxbridge update --from <新版本文件夹>` | 更新到新版本 |
| `nxbridge uninstall` | 卸载（加 `--dry-run` 先看会做什么） |

## 文档

- [使用说明](docs/user-guide.md)：安装、权限模式、配对、后台搭档、配置、更新、卸载和遇到问题时怎么办的完整说明
- [行为说明](docs/behavior.md)：各功能的实际行为、限制和已知边界
- [开发说明](docs/development.md)：目录结构、从源码构建、测试和 CI

## 反馈与许可证

安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。本仓库不接受 Issue 和 Pull Request。

许可证为 MIT，见 [LICENSE](LICENSE)。
