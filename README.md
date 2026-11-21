# nxbridge

Claude Code 与 Codex CLI 的本地平等搭档通信。双方保留原生 CLI、独立上下文和权限，通过显式消息协作。nxbridge 不调用第三个模型，不代答审批，也不把一边登记成另一边的子代理。

本文是面向开发者的仓库入口：文档分布、目录结构、构建安装和测试。只想安装使用的话，从 Releases 下载发布包，按 [docs/user-guide.md](docs/user-guide.md) 操作即可。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/behavior.md](docs/behavior.md) | 各功能的实际行为、约束和已知边界：Codex 兼容、通信入口、日常命令、投递与提醒、后台会话、daemon、配置、运行边界、验收范围、卸载与进程归属 |
| [docs/user-guide.md](docs/user-guide.md) | 面向使用者的安装与使用说明，构建时成为 `publish/README.md` |
| [docs/collaboration.md](docs/collaboration.md) | 模型特点、成本与 effort 偏好，以及通信入口（英文，随两端 `partner` 技能安装，模型按需读取） |

变更记录见提交历史和 Releases。许可证为 MIT，见 [LICENSE](LICENSE)。

问题和建议请提 Issue；安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。本仓库不接受 Pull Request。

## 目录结构

| 位置 | 放什么 |
|---|---|
| `src/` 根目录 | 只放固定入口：`cli.ts`、`hook-entry.ts`、`mcp-entry.ts`、`mod-entry.ts`、`question-control.ts`，以及全局共用的 `types.ts`、`version.ts` 等少数文件。入口名和发布文件名保持不变，插件按这些名字加载 |
| `src/app/` | 命令行分派与帮助；`commands/` 按命令放实现，运行哪条命令才加载哪条 |
| `src/broker/` | 协调器 `coordinator.ts` 及其服务，各服务管理自己的状态：`requests/`（RPC 请求契约）、`pairing/`（配对、选择、解除与恢复配对）、`profiles/`（搭档模型与推理强度）、`lifecycle/`（后台准备、恢复编排与回收）、`recovery/`（恢复、接手、会话托管与历史）、`delivery/`（消息投递、引用与协作提醒）、`health/`（轮次、资源与运行状态检查及提醒） |
| `src/hosts/` | 后台启动与宿主程序识别；`claude/`、`codex/` 放各自的协议、会话、身份和适配器 |
| `src/integration/` | 模型和宿主接入：`mcp/`（MCP 工具与问答）、`mod/`（Claude Mod 通道）、`hooks/`（hook 处理），`instructions.ts` 是 Codex 端的协作规则 |
| `src/install/` | 安装、更新、卸载、兼容检查与私有运行目录 |
| `src/config/` | 配置文件的读取、校验、重载和宿主内修改 |
| `src/ipc/` | 本机通信：socket、RPC、唤醒 |
| `src/process/` | 进程启动、归属、容器与回收；`windows/`、`posix/` 放平台实现 |
| `src/storage/` | 账本、事务、日志与数据保留 |
| `src/shared/` | 多处共用、不依赖具体功能的小工具 |
| `src/tests/`、`src/native-tests/` | 普通测试与使用实际官方 CLI 的原生测试；共用夹具在 `src/tests/support/` |
| `plugins/claude/`、`plugins/codex/` | 两端插件源文件。Claude 的协作规则在 `plugins/claude/hooks/register.js`，并同步到 `skills/partner/SKILL.md` |
| `tools/` | 构建、打包、版本同步、测试运行与诊断脚本 |
| `docs/` | 见上面的文档表 |
| `publish/` | 构建生成的发行版，不进仓库；由 GitHub Actions 构建，打版本标签时附到 Releases |
| `.github/` | GitHub Actions：推送时构建一次并测试；打版本标签时发布已通过 macOS 检查的发布包；每周两次检查新旧版本官方 CLI 的兼容性 |

Codex 插件包里的文件一旦有字节变化，用户就要在 Codex 里用 `/hooks` 重新授权，所以 `plugins/codex/` 的内容和发布文件名都要保持稳定。

## 开发与安装

### 环境要求

需要 Node.js 24 LTS 和两家官方 CLI。

已在提权 Windows 上使用实际官方 Codex 0.164.0、0.166.0 和 Claude Code 2.1.316 完成协议测试；Codex 0.166 的共用后台服务（daemon）模式在 WSL ext4 上用实际 daemon 验收。Codex 各版本的兼容情况见 [docs/behavior.md](docs/behavior.md) 的“Codex 版本兼容”。

### 构建与安装

```sh
npm ci
npm run build:publish
node publish/nxbridge.mjs setup
nxbridge codex
```

`npm run build:publish` 生成 `publish/`：它是压缩打包后的完整发行版，依赖都已打包在内，不需要 `node_modules`。拿到 `publish/` 的机器只要有 Node.js 24～26，就能直接 `node publish/nxbridge.mjs setup` 安装。

### `setup` 做什么、不做什么

`setup` 在 nxbridge 私有目录准备两端插件，通过两家官方插件命令安装，并通过 Codex 官方配置接口合并限定在 `claude` 命名空间的工具设置。

- 它不会修改模型、审批、沙箱或 hooks 信任，也不安装系统服务或修改 shell profile。
- 已有同名 MCP 配置会明确报冲突，不会被覆盖。

**安装前检查**

- 检查 Node.js 版本和 `node:sqlite`、两家 CLI 的版本与能力，以及已有的同名市场、命名空间配置和 `nxbridge` 命令有没有冲突。
- 任何一项不通过就不写入，并说明原因。
- Codex 最低要求 0.164.0；无法核验版本或版本过旧时，在安装和更新前拒绝并提示升级。Claude 仍按必需能力预检判断。
- 调用两家 CLI 的检查命令按程序逐个执行，失败时一定给出退出码和输出片段。

**命令行参数**

- `setup` / `update` 的 `--help` 只显示帮助；未知参数、缺值和非法位置参数在预检之前报错，不产生任何副作用。
- 只想看会做什么、不实际改动时，加 `--dry-run`，它和正式安装做完全相同的检查；`--dry-run` 会清理本次预检新建的空归属目录。
- 只生成插件文件、不碰两家 CLI 配置时，用 `--prepare-only`。

```sh
nxbridge setup --dry-run
nxbridge update --from <新的 publish 目录>
nxbridge setup --prepare-only
```

### 私有运行目录

安装时会把 `publish/` 复制到 nxbridge 私有目录（`~/.nxbridge/runtime/<版本>`）。插件、`nxbridge` 命令和 shell wrapper 都从这里运行，所以**装好后原工程目录可以移走或删除**。

私有目录只保留当前版和上一版；更旧的版本如果还在被运行中的进程使用，会等它退出后在下次更新时清理。

### 更新、修复与中断后续装

`setup` 可以重复执行：已安装时它就是更新和修复，`update` 是同一命令的别名。每次执行会：

- 重新生成插件文件，同步两端已安装的插件。Claude 走官方更新命令；Codex 没有官方更新命令，改为同步 nxbridge 自有的插件缓存，启用状态和 hooks 信任保持不变。
- 平滑重启 broker，现有会话和 App Server 不受影响。
- 最后用中文列出已打开窗口还需要的操作。

安装或更新中途被打断（进程被杀、文件被占用）时，直接再运行一次 `setup` 或 `update` 就会接着完成。

- 如果被打断后有文件被改过，它会列出具体文件和处理办法，不会覆盖。
- Windows 上文件暂时被占用时会自动短暂重试，仍然不行就报告占用它的进程（能查到的话）。
- 之前记下的启动程序已经不在了（比如 Claude 桌面端自动更新后删掉了旧版本目录），不会让安装停下。安装本身只需要找到能运行的 Codex 和 Claude 命令；以后在后台启动时用哪个程序，按“启动方式的选择”重新挑选，挑不出来也只在结果里提示怎么修。
- `--dry-run` 做同样的检查：安装要用的命令找不到时，预演阶段就会报出来。

**升级到新版本**

- 用 `--from` 指定新构建的 `publish/` 目录。
- 不带 `--from` 时沿用上次的安装来源；来源已经不在的话，就用私有目录里已安装的版本做修复。
- 推荐由新版本自己的安装程序执行：`node <新 publish 目录>/nxbridge.mjs update --from <新 publish 目录>`。

### `nxbridge` 命令的位置

`setup` 还会在一个已经在 PATH 里、且当前用户可写的用户目录放一个 `nxbridge` 命令，此后可以直接运行 `nxbridge status`、`nxbridge restart codex` 等。

- 新安装依次优先选 `~/.local/bin`、`~/bin`、用户自己的 npm 全局目录、当前用户可写的 Homebrew 目录，再到其他用户目录。
- 不会选 Rust（`~/.cargo/bin`）、Go、pyenv / rbenv / asdf、nvm / fnm / volta / mise 这类工具专用目录，也不会因为管理员能写就选 Program Files。
- 不需要管理员权限；已经装好的命令位置保持不变。
- dry-run 和安装结果都会显示选了哪个目录、为什么。
- 它不修改 PATH，也不覆盖不属于 nxbridge 的同名文件。
- 可以用 `--bin-dir <目录>` 指定目录，这个目录必须已经在 PATH 中，不存在的话会自动创建。
- 找不到合适目录时，安装结果会给出可直接运行的完整命令。没有 `nxbridge` 命令时，用 setup 输出的完整命令代替。

### 安装或更新后的重新加载

安装后，Claude 原窗口用 `/reload-plugins` 加载；Codex 新会话或冷恢复使用新工具。

更新后，已打开的窗口要重新加载才会用上新版本：

- Claude 窗口执行 `/reload-plugins`；如果在用 codex MCP 备用入口，再到 `/mcp` 里重新连接。
- nxbridge 后台的 Codex 等它空闲后，在 Codex 之外的终端执行 `nxbridge restart codex`。
- 你自己开的 Codex 窗口，按该命令给出的步骤退出后用原 ID 恢复。

前提条件：

- Claude 的登录和项目目录信任须已在原生界面完成，否则后台会话可能等待人处理，或不会加载 Mod。
- embedded 模式的 hooks 必须在 Codex 原生 `/hooks` 中获得信任，nxbridge 不代写信任记录。

## 验证

```sh
npm test
npm run test:native
npm run test:native:target
npm run check
```

| 脚本（`npm test` / `npm run …`） | 覆盖范围 |
|---|---|
| `npm test` | 普通测试：核心配对、队列、幂等、暂停、断连、持久恢复、Mod 契约、资源归属和 shell 包装的参数转发、编码保留与撤销 |
| `test:native` | 在独立临时配置下使用实际安装的官方 CLI 与本机模拟模型接口，验证安装、配置保留、App Server、MCP、Claude 后台 Mod 和消息往返 |
| `test:native:target` | 临时下载官方 Codex 0.166.0 二进制，验证后清理，不升级用户安装 |

- shell 用例在对应 shell 可用时执行；Windows 上验证 PowerShell，Bash / Zsh 明确跳过。
- Claude 原生后台集成用例在 Windows 运行；托管子进程用例在 Linux 运行，其他系统明确跳过。
- 测试不调用真实模型、不修改用户真实 CLI 配置，并清理自己的配置和进程。
- GitHub Actions 每次推送只构建一次，之后的测试都用这份构建结果：
  - macOS 上运行普通测试，并安装官方 Codex 和 Claude Code CLI，配合本机模拟模型运行原生测试。这部分决定能否发版。
  - Linux（Node 24、26）和 Windows 上运行普通测试，结果仅供参考，不阻止发版。
- 打版本标签时不重新构建，直接发布同一提交在 main 上通过 macOS 检查的那份发布包。
- 每周两次用最新版和最低支持版本的官方 CLI 运行原生测试，并在 Linux、Windows 上运行全部原生测试，只用于及早发现兼容问题。
- CI 里的原生测试不调用真实模型，也不需要任何账号或密钥。ChatGPT 应用界面、合盖休眠等场景只能在 Mac 真机上人工验证，见 [tools/macos-validation.md](tools/macos-validation.md)。
- GitHub 的 Windows 测试机把进程放在不允许脱离的 Job 里，系统 PATH 里也没有登记 Node。需要完全独立的后台进程才能成功的用例，以及持久 PATH 回退的集成用例，在这种环境下明确标为跳过，在普通 Windows 机器上照常执行；拒绝启动、重试等路径在测试机上照常测试。
