# nxbridge

让同一台电脑上的 **Claude Code** 和 **Codex CLI** 互相发消息，像两个平等的同事一样协作。

- 两边仍然是各自的官方 CLI，各有自己的上下文、权限和登录。
- nxbridge 不调用其他模型，不替你回答审批，也不会把一边变成另一边的子代理。
- 同一目录下没有可配对的窗口时，会在后台启动对方作为搭档；后台会话掉线后会按原会话自动恢复。
- 一台电脑上可以同时有多组配对，每个窗口只和自己的搭档通信。

## 要求

- Node.js 24～26（需要内置的 `node:sqlite`）
- 已登录的 Claude Code 和 Codex CLI。已测试：Claude Code 2.1.308 / 2.1.316 / 2.1.317，Codex 0.164.0 / 0.166.0
- 平台：
  - Windows、WSL（Ubuntu 22.04）已验收
  - 其他 Linux 发行版应该可以用，但没有单独测过
  - macOS 可以安装使用，作者尚未完成实机验收

## 安装

从 [Releases](../../releases) 下载最新的 zip，解压后在解压出的文件夹里运行：

```sh
node nxbridge.mjs setup --dry-run   # 先预演，只检查、不写入
node nxbridge.mjs setup
```

也可以直接克隆本仓库，在 `publish/` 目录里运行同样的命令：

```sh
git clone https://github.com/MiCat-S/nxbridge.git
cd nxbridge/publish
node nxbridge.mjs setup
```

安装会把运行文件复制到 `~/.nxbridge`，用两家官方的插件命令装上 nxbridge 插件，并在 PATH 里一个你可写的目录（优先 `~/.local/bin`、`~/bin`）放一个 `nxbridge` 命令。它不改你的模型、审批和沙箱设置，不装系统服务，也不改 shell 配置文件。装好后，解压出的文件夹可以删掉。

### 装好后要手动做的事

1. **Claude Code：** 在已经打开的窗口里执行 `/reload-plugins`，或者新开一个窗口。
2. **Codex：** 新开一个会话，在 `/hooks` 里信任 nxbridge 的 hooks。
3. **权限模式：** 让两边的权限模式属于同一类。Claude Code 会拦下权限类别不同的会话发来的消息：一边是全部放行（bypass），另一边是默认、auto 等需要确认的模式时，消息要你逐条审核，默认 5 分钟不处理就会丢弃。推荐两边都用需要确认的模式。
4. **检查：** 运行 `nxbridge doctor`。

## 开始使用

在同一个项目目录里分别打开 Claude Code 和 Codex，让其中一边给对方发消息：

- Claude：用 `SendMessage` 发给 `nxbridge:codex`，用 `ListAgents` 查看搭档。
- Codex：用 `claude.send_message` 发信，用 `claude.status` 查看搭档状态。

第一次发信时，如果同目录已经开着还没有搭档的另一方窗口，会先弹出选择框让你选：配对现有窗口、新建后台搭档或暂不配对。想换搭档或解除配对，在 Claude 里输入 `/nxbridge pair`，在 Codex 里输入 `nxbridge pair`。

## 常用命令

```sh
nxbridge status              # 查看所有配对和双方状态
nxbridge pair                # 列出还没有搭档的窗口，按编号配对
nxbridge watch               # 实时查看双方的消息
nxbridge pause / resume      # 暂停 / 恢复通信
nxbridge doctor              # 检查安装和运行状态
nxbridge open claude|codex   # 接手 nxbridge 在后台启动的会话（比如处理待批准的操作）
nxbridge adopt codex         # 把 Codex 会话交给后台接着跑（同一会话、同一搭档）
nxbridge release codex       # 把后台 Codex 会话长期交还给你自己的窗口
```

有多组配对时，在外部终端里执行的命令需要用 `--pair`、`--member` 或 `--session` 指定目标，ID 可以从 `nxbridge status` 里查到。

## 更新

下载新版本并解压，在新版本的文件夹里运行：

```sh
node nxbridge.mjs update --from .
```

更新结束时会列出这次需要做的事。通常是在开着的 Claude 窗口里执行 `/reload-plugins`；Codex 插件有变化时，还要在 `/hooks` 里重新信任。

## 卸载

```sh
nxbridge uninstall --dry-run   # 先看会做什么
nxbridge uninstall             # 卸载，保留配置和消息记录
nxbridge uninstall --purge     # 连同 ~/.nxbridge 一起删除
```

两家 CLI 自己的会话历史始终不会被删除。

## 仓库结构

- `publish/`：原样的发布包，内容与 Releases 里的 zip 相同。
  - 不要修改、增删其中的文件。安装程序会按 `publish.json` 逐个核对文件，有任何不一致都会拒绝安装。
  - `.gitattributes` 已关闭这个目录的换行符转换，Windows 上克隆也不会改动文件内容。
- `publish/README.md`：完整的使用说明，包括后台搭档、自动恢复、Codex 共用后台服务、提醒规则、配置和问题排查。

## 许可证

MIT，见 [`publish/LICENSE`](publish/LICENSE)。打包在内的第三方依赖的许可证见 [`publish/THIRD-PARTY-NOTICES.md`](publish/THIRD-PARTY-NOTICES.md)。
