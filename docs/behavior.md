# nxbridge 行为说明

面向开发和维护者：nxbridge 各功能的实际行为、约束和已知边界。仓库入口见 [README.md](../README.md)；面向使用者的说明见 [user-guide.md](user-guide.md)。

## Codex 版本兼容

Codex 最低要求 0.164.0，安装和更新在任何激活前拒绝更旧或无法核验的版本，并提示升级。只提供一种插件包。已实际验证的兼容范围如下；下表不是对两个版本之间或更高版本的自动兼容承诺。

| Codex 版本 | 验证结果 |
|---|---|
| 0.164.0 | 实际官方二进制通过安装、MCP、App Server、消息往返与恢复等协议测试 |
| 0.166.0 | 实际官方二进制通过同一协议测试。共用 daemon 模式在 WSL ext4 隔离配置下用实际 daemon 验收；非提权 Windows 的 daemon 未验收 |
| 低于 0.164.0 | 未认证，安装和更新拒绝；需先升级 Codex |
| 其他更高版本 | 尚未认证；是否可用取决于所需接口与实际测试，不能仅凭 release 身份保证完整功能 |

官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 将相关接口标为实验性，后续升级或降级都应先运行 `doctor` 并用对应版本完成原生协议测试。embedded 兼容模式也依赖宿主 hooks 等能力，不能保证任意旧版都可回退使用。

### 依赖的接口与投递方式

关键依赖包括插件和配置接口、并列 App Server 客户端，以及 `thread/inject_items` 和 `thread/read` 返回的持久历史路径。

按 Codex 运行方式，投递分为：

- **nxbridge 托管的后台 Codex：** 空闲时，nxbridge 用 `thread/inject_items` 注入一对带唯一 `call_id` 的 `receive_messages` 调用和结果，再以空 `input` 开始新一轮；忙碌时由 Codex 在 hook 提示后自己调用 `receive_messages` 取件。
- **非本机 App Server**（通过 `hosts.codex.endpoint` 等方式连接）：没有可核验的本机持久历史，仍用有次数上限的唤醒加取件。
- **共用 daemon 线程：** 无论忙闲都只等线程自己取件。

送达判定：

- 不使用不带 `call_id` 的裸 `toolOutput`，因为它只被 Responses WebSocket 接受，走 HTTP 的 provider（或 WebSocket 失败后退回 HTTP）会在消息进入上下文后整轮失败。
- 送达以官方 `thread.path` 指向的持久历史中完全匹配的 `call_id` 与消息编号为准。
- 历史格式无法核验时保持"不确定"，不会误报已送达，也不会重复注入。

### 客户端身份

**会让 Codex 调用模型的连接**（nxbridge 托管的后台 Codex、需要跑轮次的远程端点）：

1. 每次连接都先用原生非发起客户端 `codex-backend` 握手，从返回的原生 User-Agent 读出服务器实际版本。
2. 关闭后再以官方 TUI 的身份 `codex-tui`（title 为空、版本即该版本）重新握手。
3. 在任何线程请求之前核对版本一致；版本无法核验或连续变化时明确报错，不猜测。

**只读连接**（安装预检读取配置、共用 daemon 的只读客户端）只用 `codex-backend` 单次握手，不改动原生的 originator、User-Agent 或自动登录策略。

**终端识别变量：** Codex 用来识别终端的环境变量（`TERM`、`TERM_PROGRAM`、`WT_SESSION` 等）取自本机实际情况：优先用发起这次后台启动的 Claude 窗口的真实环境，其次用记录的 Codex 窗口环境，都没有时不带；只带这些识别变量，不编造。所以每台机器上，模型请求的 User-Agent 都与那台机器上直接打开的官方 Codex 逐字节一致。

**安装渠道变量：** nxbridge 启动 Codex 时直接运行原生程序，这样才能准确识别进程，因此不经过官方 npm 包里的 `bin/codex.js`。这个入口会额外设置 `CODEX_MANAGED_PACKAGE_ROOT`，以及 `CODEX_MANAGED_BY_NPM`、`_PNPM`、`_BUN`、`_VITE_PLUS` 中的一个，Codex 据此判断安装方式、给出对应的更新命令。nxbridge 按同样的规则补上：先清掉继承来的同类变量，确认选中的原生程序确实是这个包自带的那一份，再设置包目录和唯一一个包管理器标记。前台窗口和后台搭档都这样处理；Homebrew、桌面应用自带或独立安装的 Codex 不带这些变量。所以经包装运行 `codex doctor` 时，显示的安装方式、包目录和更新命令与直接运行官方入口一致。

**已固定为其他身份的 App Server：** Codex 的 originator 由第一个发起客户端决定、之后不可更改。

- 已经以其他身份运行的 nxbridge 托管 App Server 无法改名，nxbridge 会暂停向它投递、不开新轮次，等它空闲后自动安全重启（同一会话 ID 和历史），再以官方身份投递。
- 无法重启的远程端点只暂停投递并提示。
- 任何情况下都不会以非官方 Codex 的 User-Agent 发出模型请求。

## 运行方式与通信入口

**Codex 线程与 App Server**

- 普通可见 Codex 线程由原版 TUI 创建。
- 管理员 Windows 下，TUI 直接连接独立的原版 App Server；协调器使用并列连接收信。
- 无法挂接的 embedded 运行方式保留原生启动参数，通过固定通知和取件工具兼容收信。
- Codex 0.166 默认的共用 daemon 另见“Codex 共用后台服务（daemon）”。

**模型侧的通信入口**

- Codex 模型使用 `claude.send_message`、`claude.status`、`claude.receive_messages`。
- Claude 优先沿用原生 `ListAgents` 与 `SendMessage`，搭档地址为 `nxbridge:codex`；同包 MCP 提供 Mod 不可用时的工具入口。

**模型提示与语言**

- 两端模型提示与 `partner` 技能使用精简英文，面向人的 CLI 和状态显示保留中文。
- 模型特点写在 `docs/collaboration.md`，模型通过 `partner` 技能按需读取，人也可以直接看。
- Codex 端分工、调度规则常驻在 MCP instructions，第一条写明“以下是主会话的规则”并列出子代理的限制。`partner` 技能除了指向模型特点，还承载子代理委派规则：Codex 内置规则只认用户本人、AGENTS.md 和技能说明这三种授权来源，所以委派授权只能放在技能里。Claude 端技能是无 Mod 时唯一的规则载体，保留完整规则。

**任务调度与子代理**

- 非简单任务开工前，两边在联系得上对方时先商定分工和可并行的部分，再各自派子代理；负责人持续推进关键路径，只在真正依赖处等待，并负责合并和发版。重型测试或构建两边同时只跑一组。这些都是默认做法，用户的直接意愿优先：消息、AGENTS.md / CLAUDE.md、任务要求，以及搭档转达的用户意愿。
- Codex 子代理：技能里的规则让 Codex 把比较独立的工作（功能实现、排查、各平台的工作、评审等）交给子代理，默认同时最多 2 个，子代理不再往下派。这个上限只写在提示里，不改 Codex 的并发配置，用户要求更多时可以照做。不写全局配置，也不在启动时注入参数，所以用着 nxbridge 插件的 Codex 不管怎么启动都适用；Codex 没读到技能时，退回它原本的行为，即用户明确要求才派子代理。
- 子代理会带着主会话缓存下来的规则文字，第一条规则让它们不去照做，并不能把这段文字从上下文里去掉。真正的限制在 nxbridge：确认是 Codex 子代理时，拒绝它发消息、提问等面向搭档的操作。Claude 子代理收不到 Mod 注入的规则，对外发信仍按 `collaboration.subagent_send` 处理。
- 任务说明里的 nxref 只在经过本地 hook 的原生 `spawn_agent` 调用里展开，新旧两版多代理机制都支持，引用不存在时在派生前拒绝。服务端托管的多代理调用不经过本地 hook，nxbridge 拦不到，这时模型要先取回内容、直接写进任务说明，不能把未展开的引用交给子代理。
- worktree 只是有 git 时可选的并行手段。Codex 完工后不带强制参数删除自己没用的 worktree 和临时文件，删不掉的把路径和原因交给 Claude；Claude 先查清原因，确认范围安全才强制删除，否则问用户。

## 日常使用

### shell wrapper

想继续直接使用 `codex`、`codex resume`，可安装可撤销的 shell wrapper。它将这些调用转给 nxbridge 启动入口，再由入口调用官方 CLI：所有参数（包括 `--version`、插件管理、登录、`--worktree`、profile）原样转发给原版，只有下文“包装与官方命令的区别”里的一种例外会连接 nxbridge 后台。

基础 `setup` 不改 profile；只有显式安装 wrapper 时才写入指定文件。

PowerShell 一次性安装并在当前终端加载：

```powershell
nxbridge install-wrapper --shell powershell --file $PROFILE.CurrentUserAllHosts
. $PROFILE.CurrentUserAllHosts
```

Bash / Zsh 分别指定 `--shell bash --file ~/.bashrc` 或 `--shell zsh --file ~/.zshrc`，随后重新打开终端或加载对应文件。

安装后按原来的方式使用：

```sh
codex
codex resume
codex resume --last
```

实现约定：

- wrapper 不替换官方可执行文件或修改 PATH，内部直接调用官方 CLI，不会递归调用自己。
- PowerShell 5 的引号、空参数和中文通过 argv 序列化保留，管道输入以 UTF-8 转发；Bash / Zsh 使用 `"$@"` 并继承标准输入。
- 已有 profile 的 UTF-8 / UTF-16LE BOM、换行及区块外内容保留，重复安装更新同一管理区块。

撤销 PowerShell 包装：

```powershell
nxbridge remove-wrapper --file $PROFILE.CurrentUserAllHosts
```

- 重新打开终端后恢复原来的命令解析。
- `uninstall` 也会回收已登记的包装；用户改过的管理区块保留并报告。
- 临时绕过包装时，PowerShell 可直接调用官方 `codex.cmd` 或 `codex.exe`，Bash / Zsh 使用 `command codex`。

包装与官方命令的区别：

- 包装的 `codex`、`resume`、选择器和分叉默认直接调用官方原生入口，完整转发权限、模型、profile 等参数，继承当前终端的环境变量和工作目录，并像官方 npm 入口一样标明安装渠道（见“安装渠道变量”）；不强制 remote、不覆盖会话目录选择，也不关闭原生更新提示。`nxbridge codex` 走同一条路径。
- 唯一的自动接入后台例外：明确指定会话 ID，且核验它此刻已经加载在 nxbridge 自有后台里时，连接这个现有后台，不另起竞争的运行时。托管搭档按临时接手处理（见“会话在窗口与后台之间转移”）。显式 `--remote` 仍连接指定端点，只有自有端点才按 nxbridge 运行时处理。
- `codex.cmd` / `codex.exe` 不经过包装。同一会话同一时刻只能有一个 App Server 持有写入锁，另一处打开会看到 “This conversation is open in another app”。窗口关掉后锁怎么释放，见“打开方式与唤醒”。

### 命令一览

```sh
nxbridge status
nxbridge pair                                   # 列出还没有搭档的窗口（按编号配对）和之前的后台搭档
nxbridge pair --claude <编号|成员ID|会话ID> --codex <编号|成员ID|会话ID> [--replace]
nxbridge pair --restore <原配对ID>              # 接回一组已结束的配对（原成员、原会话）
nxbridge bootstrap                              # Windows：启动独立后台协调器（先核验当前环境能独立运行）
nxbridge open codex
nxbridge open claude
nxbridge adopt codex [--session <会话ID>]       # 把 Codex 会话转到后台托管（同一会话、同一配对）
nxbridge retire --member <成员ID>              # 重新核验并回收已解除配对、由 nxbridge 启动的残留后台
nxbridge release codex                          # 把后台 Codex 会话长期交给你自己的窗口
nxbridge partner-profile codex|claude [--model <模型>] [--effort <推理强度>] [--reset]   # 查看或修改后台搭档的模型和推理强度
nxbridge pause
nxbridge resume
nxbridge restart codex [--session <会话ID>]
nxbridge recover codex --dry-run
nxbridge recover codex --turn <turn ID>         # 中断卡住的这一轮，或让失败停下的后台 Codex 接着做
nxbridge watch
nxbridge watch --once
nxbridge doctor
```

- `watch` 展示完整消息正文与状态，`watch --json` 提供机器可读事件。
- 外部终端有多组配对时，`pause`、`resume`、`unpair`、`restart`、`open`、`adopt`、`release`、`recover`、`partner-profile` 需用 `--pair`、`--member` 或 `--session` 指定目标；窗口内默认本窗口的配对。
- `open` 打开原来的会话 ID，不创建另一份上下文。
- Windows 后台协调器和托管运行时须脱离启动它的窗口所在 Job；做不到时返回 `bootstrap_required`，运行 `nxbridge bootstrap` 后重发即可。`bootstrap` 先用一次性探测进程核验当前环境能否脱离 Job，通过后才交接现有协调器；探测不通过时协调器、启动预约和后台状态都不变，只提示改在普通 PowerShell 运行，因此 AI 也可以直接调用。失败不会全局阻止其他调用环境重新核验和启动；同一调用进程和同一原生宿主代次下的短命 hook 有三十秒冷却，避免反复重试，普通 PowerShell 不受其他宿主的失败影响。`setup` 交接协调器前做同样的探测。

### 配对

**配对成员与会话轮换**

一台电脑可以同时有多组 1:1 配对。配对成员是经核验的窗口（原生进程身份；Codex 共用 daemon 下例外，按线程，见下文），带着它先后用过的会话 ID 列表。

- Claude `/clear`、窗口内 resume，Codex `/new`、窗口内 resume / fork，都只轮换当前会话，搭档不变，对方收到区分“上下文已清空”和“已切换对话”的提醒。
- Codex 成员按“会话 ID + 配置目录”认人，不看打开方式：同一会话换用 daemon、`--no-daemon`、`nxbridge codex` 或后台托管打开，都是同一个成员、同一组配对（见“会话在窗口与后台之间转移”）。项目目录不一致时不自动接回，由用户选择。
- Claude 新进程 `--resume` 旧会话时，只在原窗口确认已退出且唯一匹配时接回原配对，否则按未配对窗口处理。
- 已有配对不会被新窗口或 fork 抢占，替换需 `pair --replace`。

**首次配对**

没有配对时，第一次发信若同目录已有未配对的对方窗口（含唯一一个），一律先让用户在原生选择框里选大类：现有窗口 / 新建后台搭档 / 暂不配对。

- 选择框不列具体窗口；唯一候选直接点名，多个候选时由 AI 在对话里和用户确认，再用 `select_partner` 提交用户的选择。
- 选定后自动发出原消息，不静默占用用户开的窗口。
- 没有候选时才直接按需启动原生后台搭档，每组托管配对按需使用自己的 App Server。有可接回的之前的后台搭档时也算有候选，先让用户选择（接回 / 新建 / 暂不配对），不静默新建。
- 也可在目标窗口输入一次性配对码 `nxbridge pair <码>`。

**换绑**

已配对时 `/nxbridge pair`、模型工具 `choose_partner`（只打开选择框）或 Codex 输入框 `nxbridge pair` 打开同一选择框换绑：现有窗口 / 之前的后台搭档 / 新建后台 / 解除配对 / 保持不变，替换原子完成。

- 没有原生提交证据的未送达消息标为作废（`cancelled_message_ids`，可由 AI 按需重发）。
- 可能已被看到的列为 `uncertain_message_ids`。
- 两者均不自动重放。

**接回之前的后台搭档**

换绑或解除配对后，被换下的 nxbridge 后台搭档不会丢：只要它的会话历史还在，就可以接回来，继续原来的会话和上下文。

- 候选：本窗口以前配过、由 nxbridge 启动的后台成员（主会话或 fork），已启用、当前没有配对，原配置目录里的会话历史核验可恢复。同一个成员只列一次。你自己开的窗口不在此列（关掉后不会被 nxbridge 代为启动）。
- 选择框：只有一个时直接点名（如“之前的后台 Codex「名称」”，Codex 窗口里是 Claude）；多个时只给一类，由 AI 在对话里和你确认要哪个。选择框最多四项，现有窗口和之前的后台搭档都有、放不下时合并成一类“现有窗口或之前的后台 Codex（N 个）”。
- 提交前重新核验：成员仍空闲、会话历史仍在、没有被别的窗口或后台占用；随后按“托管搭档自动恢复”的方式在后台接着原会话运行。核验不通过时当前配对不变，不新建会话，也不重放旧消息。
- 终端：`nxbridge pair` 在编号列表下另列“之前的后台搭档”，带成员 ID 和会话 ID（没有编号）；用 `nxbridge pair --claude <…> --codex <…>` 按编号、成员 ID 或会话 ID 指定，原来有搭档时加 `--replace`。`nxbridge pair --restore <原配对ID>` 也能直接接回一组已结束、双方都空闲的配对。
- 同一对成员来回换过多次时，按最近的一次配对接回；同一个会话配过不同的搭档时，用 `--pair` 指定。

### 协作提醒与异常检测

**协作提醒（推断可能忘了协作）：** 只在工具结果附加上下文中提醒，不唤醒、不代发、不开新轮次。

- 证据闸门：本方 busy（只计实际 busy 时间，ready / paused / 等待人工 / 离线 / 供应商阻塞不计），搭档持续 ready，双方无上下文切换、暂停、离线，无进行中的结构化问题，无未送达或结果不明的消息；搭档 busy 一律不提醒（无法判断它在做的是否是委派任务）。时钟从配对或当前上下文开始（含零消息），真实往来推后时钟；本方发出消息重置次数，收到消息只推后时钟。
- 阈值按检查时的实际 effort：B=`collaboration.sync_tip_minutes`（默认 30，0 关闭全部协作提醒），xhigh/max 为 B，high 5B/6，medium 2B/3，low/minimal 及未知或数值预算为 B/2；按同一间隔重复，每段最多 3 次；effort 变化只影响下次判定。未配对且未禁止隐式配对时，提示首次发信按需配对；用户主动解除过配对的成员按持久标记不再提示。
- 计时只累计实际观察到的 busy：两次观察间隔超过 120 秒的部分不计，协调器启动时暂停已持久化的计时；未配对的根会话也由现有 5 秒周期采样。`sync_tip_minutes` 为 0 时不累计。
- 长上下文：用最近一次请求的输入侧 token（含缓存，非累计），固定档位 400k / 600k / 850k（`contextTipTokens`），同一对话每档一次（换绑定代次或配对不清除已过档位，只清除待发和旧用量），一次跨多档只发最高档；确认的压缩只作废旧用量和待发档位，压缩后第一次新用量作为基线，基线及以下档位视为已过。**压缩不重置沉默计时、提醒次数和 `busy_unanswered` 升级锚点**（实际 Codex 会话约每 26–36 分钟自动压缩一次，重置会让沉默提醒永远不触发）。Claude 侧经 Mod 随节流的 tip-sync 上报 `$.session.usage()` 与确认的压缩；Codex 侧取原生 token 用量通知。
- 与空闲提醒合并：同时到期的空闲或台账提醒与协作提醒合成一条，共享 B/2 冷却；`busy_unanswered` 的升级时间按第一次协作提醒计，重复提醒和长上下文提醒不推后它。
- 文本只陈述观察（搭档空闲时长、未联系时长、长上下文、需要处理的消息编号）和可做的事，按 nxbridge 默认分工加用户额外要求重新分工，允许判断应独自完成。

**异常检测只陈述事实、不做语义判断：**

- 搭档转为空闲超过 `collaboration.idle_notice_minutes`（默认 2，0 关闭）分钟、且有它看过却没有关联回复（Codex 用 `in_reply_to`，Claude 由 Mod 按已核验来源自动关联）的委派消息时，向委派方发提醒。同一批未回复的委派消息只唤醒一次，之后的提醒只附加、不唤醒，不打扰空闲方。
- 搭档收到同步提醒后又过一个同步周期仍未回复委派消息时，即使工作有进展也提醒委派方（只附加、不唤醒）。
- 投递长时间停在某一状态、忙碌却无进展或只能等工具、进程或协调器掉线、Mod 未登记或版本过旧、Codex hooks 执行失败或长时间没有事件，都会作为一次性事实通知送达相关方，并出现在 `status` / `doctor` 和 Claude 状态栏。
- 搭档这一轮在原生重试用完后失败并停下（Claude 和 Codex 都算）：再等 30 秒（排队的消息或新一轮可能马上接上），然后叫醒另一方一次，写明原因（有模型服务返回码时一并写出），由它决定发一条简短的继续消息、自己接手，还是告诉用户。不要求委派方事先标了要回复；同一轮只叫一次，新的失败轮次重新提醒，同类提醒每 10 分钟最多一次；限流、额度和登录这类通常会持续的原因，会提示先看状态、不要反复重发。nxbridge 不会自动替任何一方继续。
- 唤醒 Codex 的次数用完（消息仍在它的持久收件箱），或消息已进入原生历史、但模型续跑 3 次都失败：对方空闲时叫醒发信方一次。nxbridge 在后台启动的搭档，由发信方判断要不要发一条简短的继续消息再试；用户自己开的窗口，AI 会告诉用户在原窗口继续的具体一步（取件时还要调用 `claude.receive_messages`），不重启、不重发。还在重试或最后一次结果不明时只显示在状态里。

### 卡住的 Codex 轮次（`recover`）

Codex 一轮工作长时间没有进展时，`status`、`/nxbridge` 和 Claude 状态栏会提示具体情况：模型服务挡住了请求（返回码或超时、连不上，以及最近一次时间）、网络重连中（第几次）、正在等工具执行完成、这一轮失败，或者原因未知。nxbridge 不会因为时间到了就自动中断。这一轮失败时，状态栏会写出模型服务给的原因（原生重试用完时注明“已重试到上限”），并按上面的规则叫醒 Claude 一次。服务直接拒绝请求本身时（例如“当前模型要求更新版本的 Codex”），通常会重复出现：状态栏写明持续出现就需要升级 Codex 或换用其他模型；被叫醒的 AI 会把确切错误转告你，最多再试一次，不会反复重发。以失败结束的这一轮可能一个 hook 都没跑到，不会因此报“hooks 没有生效”。

模型服务挡住请求时（`health.modelRequest.blocking === true`），原因只有用户能处理或只能等待：只陈述原因，不给恢复命令、不唤醒模型、不追加继续指令，也不再派生 hook、投递或联系频率类提醒。原生的内部 HTTP 重试不发 App Server 通知，所以证据来自 Codex 诊断库中本会话、本轮、本进程的 HTTP 客户端记录，只读取状态码、类别和时间，不读取地址、请求头或正文；诊断库缺失、改版或锁定时视为无证据，仍显示“原因未知”。

确认确实卡住后：

1. 先用 `recover codex --dry-run` 查看目标。
2. 再用 `recover codex --turn <turn ID>` 中断这一轮，并让 Codex 检查已有进度后继续。

这一轮已经失败停下（原生重试用完，例如限流、模型服务拒绝请求），而你仍要后台 Codex 接着做时，用同样两步：`--dry-run` 会给出失败那一轮的命令，执行后不需要中断，直接在原会话发出一次由你发起的“检查已有进度后继续”指令。同一轮只接受一次，再执行会提示已经请求过、不再发指令；模型服务本身的问题（限流、额度、版本要求）不会因此修好，再失败时按上面的规则提醒。

约束：

- 执行前会再次核对：卡住的轮次在最近 30 秒内有进展、或者已经正常结束，都会拒绝执行；失败停下的轮次只接受最近一轮，之后有了新的一轮、新进展，或者 Codex 正在等问题、审批或重启时也会拒绝。
- 命令只表示指令已经提交；Codex 是否真的开始了新的一轮，用 `nxbridge status` 确认。
- 文件、后台命令和消息记录都会保留。
- 恢复命令要在 Codex 之外的终端执行。

**模型服务重试（`networkRetrying`）**

- 原生报告这一轮在等模型服务重试（如 5xx）时记为 `networkRetrying`：不自动中断或重启，状态和提醒不再建议 `recover --turn`。
- 此时 AI 发起的恢复一律拒绝，只有用户在 Claude / Codex 之外的交互终端（没有 Claude / Codex 祖先进程、有 TTY）明确执行才会中断。
- 重试用完、这一轮失败并停下 30 秒后，叫醒配对 AI 一次，由它决定是否让对方继续，不重放；Claude 和 Codex 两边都适用。之后同一运行时重新有模型输出时，只在查询状态时可见，不再另行通知。

### 冷重启 Codex（`restart codex`）

`restart codex` 用原 ID 冷重启 nxbridge 自有的 Codex 会话，让它加载新版的提示、工具和技能，历史、model/effort 以及原有审批和沙箱设置都保留（改了 `config.toml` 里的审批或沙箱，要新开会话才生效）。

冷重启会重新读取 `config.toml` 里的模型服务配置（地址和认证）。如果会话启动后这部分配置改过，即使 `modelProvider` 名称没变，请求也可能发往另一个服务。会话历史里的加密推理记录只有原来的服务认可，换了服务会被拒绝，报 `invalid_encrypted_content`，而且之后每一轮都会重复。遇到这种情况，先把模型服务配置改回会话原来用的那个服务，再重启或恢复会话；配置改回之前反复续跑没有用。

- 会话正忙、有已经尝试投递但结果未确认的消息（发送中、交给宿主排队、被扣留，或续跑、唤醒尚未确认），或与其他线程共享 App Server 时拒绝执行。
- 只剩“结果不明”的旧消息时，同一次重启请求里分段读完这个会话的完整本地历史（每段有上限，段间重新核对条件）：历史里找到的按“已进入对方上下文”结算；完整历史里都没有、且核对期间这条消息没变过的，不再挡重启，但状态保持“结果不明”，也不会重发。历史缺失、格式不支持或读不完时照旧拒绝，不停止原会话。从未尝试投递的排队消息不阻止重启，重启后照常送达；上一轮因模型服务失败停下（原生状态为 `systemError`）也算空闲。
- 要在 Codex 之外的终端执行，完成前不要关闭这个终端。
- 用户自己开的窗口只给出原生重启步骤。
- 状态栏提示“已信任新版 hooks 但会话还在用旧版”或“还没加载新版规则”时，按这个会话是谁开的（`integrationIssues` 里的 `owner`）只给出对应的一种做法：nxbridge 后台开的，写明由搭档 Claude 在它空闲时重启；用户自己开的窗口，请用户空闲时退出再按原会话 ID 恢复。判断不出是谁开的时才两种都写。

### 按成员关闭（on/off）

用户可以关闭任一侧的 nxbridge。关闭的成员 `enabled=false`，持久保存在账本，并投影到私有目录的 `member-control.json`，供 hooks、MCP 和 Claude Mod 在不启动协调器的情况下只读判断。

关闭期间：

- 协调器对该成员不投递、不唤醒、不开轮次、不注入、不重启或迁移身份、不发运行时提醒、不报健康异常，也不隐式创建、恢复或替换它；窗口关闭后同样不会拉起。
- 配对和已排队消息保留，新发给它的消息以 `member_disabled` 拒收。
- 该侧的 hooks、MCP 工具和 Claude Mod 除开关与状态外一律不做事，Mod 也不再注入系统提示段落或拦截发信。

开关来源：

- 模型工具 `set_enabled` 只能关闭（target 为 `self` 或 `partner`，需 `user_requested`）。
- 开启只接受人工来源：Claude 根窗口输入框的 `/nxbridge on [codex|claude]`、Codex 输入框直接提交的 `nxbridge on [self|codex|claude]`，或独立交互终端的 `nxbridge on <codex|claude> [--member|--session|--pair]`。

### 搭档问答

**Codex 问 Claude**

- 处理 Claude 交来的任务时，Codex 有疑问使用 `claude.ask`，不要误用无人查看的原生提问。
- 它立即返回 `request_id/pending`，答案随后以关联消息送达，保留原生 `answers` 结构并单列来源、理由。
- 默认等待十分钟，到期明确报告“搭档未答复”。
- 用户直接交来的任务，需要用户决定时仍用原生提问。
- Codex 问 Claude 时，Claude 用注册的 `answer_question` 回答，或用 `ask_user` 受控升级给用户。

**Claude 问 Codex**

- Claude 照常使用 `AskUserQuestion`。
- Mod 只将可核验为 Codex 发起的当前 turn 的问题交给搭档，等待 `claude.answer_question` 回答后返回原生结构及来源说明；`needs_user`、超时或取消回原生表单。
- 用户与未知来源的 turn 保留原生。
- 没有选项的自由文本题可问搭档，无法无损映射到 Claude 原生表单时明确交回提问方收集用户意见，不虚构选项。

**共同规则**

- 挂起问题先回答或升级，不反向提问。
- `status`、`watch` 和 `watch --once` 展示问题、选项、截止时间和结果。
- 配对暂停、会话结束或协调器重启会封存未完成问题，旧答案不会自动重放。
- Codex 不拦截原生 ask 或审批，也不修改 MCP 工具超时。

## 消息投递与提醒

### 送达失败时发信方自动知道

**消息送不到时，发信的模型会自动知道。** 模型不需要自己去查状态或问对方：

- 发信结果按实际情况写明：已提交、正在启动搭档、投递受阻、可达性未确认、暂停、宿主暂扣或拒收、结果不明。只保存、还没提交的，不会说成“已提交”。
- 后台服务每 5 秒检查一次对方的进程、收件箱和连接。送不到时给发信的模型发一条系统提醒，恢复时再发一条，同一事件只提醒这两次。提醒标明“不是搭档回复”，不会被当成任务。
- 后台服务异常退出后重启时，会检查没送出的消息：确定没提交过的继续投递，中途被打断、结果不明的标为“不确定”，**不会自动重发**。
- 后台服务和桥接进程都死掉时，Claude 端由 Mod 每 15 秒不经协调器独立检查。协调器连续 120 秒不可达（已卸载或启动预约进行中时不计；Claude 端两次观察间隔超过 60 秒则重新计时，Codex hook 观察稀疏时跨间隔累计；启动预约读不出时照常给出诊断任务，启动仍由 `bootstrap` 核验）即为一次断线（`broker_outage`，按 `epoch` 计；协调器稳定可达 120 秒后才结束这次断线，降级不影响结束：降级另有提醒，5 分钟无活动的降级记录自动过期），同一 nxbridge 目录下所有窗口通过 `run/broker-outage.db` 的短事务比较交换只认领一次，只有用户自己的窗口（`owner=user`）有资格认领，nxbridge 自己的无界面后台会话不会被叫醒：认领的那个窗口收到 `wake:true` 的唤醒，任务是先运行一次 `nxbridge doctor`（只诊断，不启动协调器）；确认协调器离线就运行一次 `nxbridge bootstrap`（先核验再启动，失败代价低）；仍不可达或反复崩溃时读 `run/broker.log` 末尾，把原因和用户要做的一步报告给用户，不改数据库、不结束进程、不循环重试；其他窗口只附加、不唤醒。认领后 60 秒内未入队即视为放弃，换别的窗口；已入队但确认没写入正文（写入前出错、插件重载或切换对话丢失租约、消费时任务已撤回）、入队后超时或认领者退出时释放给别的窗口，排除名单有时限；正文已交给 AI 或结果不明的从不重放。上一次唤醒后 1 小时内同一 nxbridge 目录不再唤醒，只附加说明，避免协调器反复崩溃时循环叫醒。断线记录库损坏时保留原文件、不再自动唤醒，普通提醒照常。协调器恢复后，每个窗口只附加一条恢复说明，不唤醒。Codex 端在下一次受信任的 hook 事件里收到同一断线的任务，与 Claude 端共用同一个认领；Codex 完全空闲、没有任何事件时，要等它下次有动作才会知道。
- 后台启动失败时，发信结果、`status`/`doctor` 和一次运行时提醒给出具体原因和重试命令，已接受的消息保留。

### 唤醒策略

唤醒策略集中在通知层，按提醒类型 + 接收方能否处理决定：

- 后端给每条通知（含合并通知）明确的 `wake:boolean`，只要有一个当前需要该 AI 处理的部分（欠回复、限定的恢复步骤、本窗口自己的重载）才为 true；告知类与只能由用户处理的事实为 false，缺省也按 false。
- Mod 只对 `wake===true` 走原生 inbox 开回合，其余用 `$.session.append` 只附加历史。
- 排队唤醒在消费时重新核验，已降为告知的在空闲时不开回合。
- 后台重启按消息 ID/状态去重，不重复同一事实。

### 消息状态

- 消息状态区分已持久化、运行时已接受、等待人工处理、上下文观察、关联回复和不确定。
- `unknown` 不等于失败；远端可能已收到，不会自动重复投递。仅在人核对后，使用 `retry <message-id>` 明确重试。
- Claude Windows inbox 的传输写入不是语义回执。无法取得更强证据时保留 `unknown`，不会显示成“已读”。对方明确关联回复或宿主提供的有效回执才能推进状态。

### 文件引用提醒

消息引用至少两处不同的文件、目录或行范围时，投递时附一条临时提醒：如果要读，一次并行读取，并注意文件编码。

- 只是列出文件、读者不需要读的时候，不会催读者去读。
- 支持 `path`、`path:line`、`path:start-end`、`path#L12-L20`、Markdown 链接和 Windows 路径；忽略 fenced code、URL、版本号及重复引用。
- 单处不提醒，不重复附引用清单，不检查文件是否存在，也不修改正文或消息账本。

### 发信时的即时提醒

nxbridge 只做机械检查，提醒写明“这不是判断，如果是有意的就照常继续”，不拦截、不改正文：

- 发给搭档的消息超过 2,200 字符时，提醒汇报原则：工作做得彻底不等于报告写得详尽。
- 消息里有连续 300 字符以上和之前的配对消息、或自己已完成的子代理结果一字不差，且没用 nxref 时，直接给出可用的 `nxref:msg:<ID>` 或 `nxref:agent:<ID>`。Claude 的子代理提示也会检查。
- 每轮最多提醒一次，同一种提醒至少隔 10 次发送才再出现。整段代码块、引号包起来的原文、JSON 和标明“原文”的内容不计入。
- `nxbridge status`、`doctor` 会显示每一方的发信数量、长度、nxref 使用情况，以及提醒之后的变化，用来观察提醒有没有效果。这只是前后对比，不能证明因果。

## 后台会话

### 启动方式的选择

nxbridge 在后台启动 Codex 或 Claude 时，尽量和你平时打开它们的方式保持一致。你自己打开窗口时，nxbridge 会记下这个窗口实际运行的程序、配置目录和环境变量；后台启动时照这份记录来。按以下顺序决定用哪种方式：

1. 你用 setup 指定的启动命令，或指定的程序加配置目录。
2. 本组配对中窗口的记录。
3. 自动选择：先确定最近使用的“程序 + 配置目录”组合，再在这个组合里优先选同一项目目录的记录；没有的话，用该组合最近的一份，并注明它来自哪个目录。另一套安装的记录即使目录相同也不会被选中。记录里的程序已经不在时，先换成同一安装渠道的新版本（见下文第 3 条）；换不了就跳过这份记录，改用同一配置目录里其他还能用的记录。
4. 都没有时，使用系统保存的环境变量和 PATH，并明确提示；记录里的配置目录仍然沿用。记录里的配置目录都已不在时，不会自动改用默认目录（那可能是另一个账号或另一套设置），而是提示你恢复目录或指定配置目录。这一条只在 Windows 上有保证；Linux / macOS 改为继承当前环境、去掉会话专用变量；Linux 已在 WSL 验收，macOS 尚未验收。

接着跑已有的会话时（转到后台、重启、崩溃恢复、临时接管、后台 Claude 恢复），用另一套更严格的选择，同一套逻辑供这些路径共用：

1. 你用 setup 或 `config` 固定的启动命令或程序；只固定配置目录时，程序仍按下面的顺序选。
2. 这个会话自己留下的记录：打开它的窗口实际运行的程序。走共用 daemon 的窗口记下的是那个 daemon 进程的程序和版本（连接核验时按进程号和启动代次记录）。
3. 记录里的程序被更新或清理掉时，只换成同一安装渠道自己的正式入口：Homebrew 的固定入口、Codex daemon 安装目录里的当前版本、VS Code 扩展的当前版本、Claude 桌面端自带的版本目录（Windows 是 `claude-code/<版本>/claude.exe`，要带 `.verified` 标记；macOS 是 `claude-code/<版本>/<哈希>/claude.app/Contents/MacOS/claude`；版本不低于原记录，且确实是本机格式的可执行程序）。不换成 PATH 上或其他应用里的程序。
   - 桌面端同一版本下有多份程序时，先核验它们报出的版本和架构一致，再固定选一份（原记录那份还在就选它）；不一致时报 `launch_image_ambiguous` 并停下等待，不按文件名或修改时间猜。指定了 `hosts.claude.binary` 或启动命令时不做这项选择。
4. 只有这个会话完全没有记录时，才用同一配置目录里其他窗口的记录，先选同一项目目录的；用了会在状态里注明程序和版本。

每个候选都先运行 `--version`，版本不能低于会话文件里记录的写入版本（Codex 的 rollout `cli_version`）。都不合格时报 `profile_version_unsupported`（有版本可比）或 `launch_profile_missing`，列出检查过的程序、版本和原因，并给出修法。

只有所有候选都因为不改配置、安装或会话就不会变的原因失败时，才停下等待（`hosting.nextAt` 和恢复事件不再按时间重试），并记下这些输入的指纹：相关配置项、本会话的启动记录、候选程序和正式入口的路径、大小和修改时间、会话文件和配置文件。配置保存、`nxbridge reload`、重新登记原会话，或指纹变化（约每 30 秒做一次只看文件属性的检查，不运行程序）时立即重新核验一次。超时、锁竞争这类临时失败仍按原来的退避重试。

新建后台搭档（不是接着已有会话）时：

- 你固定的启动命令或程序、配对时选定的入口优先。
- 否则在同一配置目录的记录里，按选用时重新运行 `--version` 得到的版本选较新的；记录里的版本只用于先显示。
- 共用 daemon 的记录只取程序，不带它的环境变量；带版本号的 daemon 路径换成同一渠道的当前入口。
- `nxbridge status --json` 的 `launches.selections.codex.selectionReason` 写明选了哪里的程序（如 ChatGPT 应用自带、Homebrew、daemon）、检测到的版本和配置目录。不想用它时，用 `config` 固定程序。

启动记录的约定：

- 只用你自己打开的窗口的记录做模板；nxbridge 后台启动的会话也会单独记下它所用的配置目录，但不会被当作模板。
- 走共用 daemon 的窗口只记下 daemon 进程的程序、版本和配置目录，不记环境变量；这份记录只用来确定这个会话以后用哪个程序接着跑，不当作新会话的模板。
- 会话 ID、通信 socket 这类窗口专用变量不会被沿用；代理、API key 等正常启动环境会保留。
- 程序、配置目录或项目目录已经不在的记录会保留（接着跑已有会话时要用它核对来源），只是不再被选用；`doctor` 会标出原因和实际改用的程序，不用手动清理。
- 记录保存在 nxbridge 私有目录，只有你的账户能读；`status` 和 `doctor` 只显示程序、版本、目录、变量名以及被丢弃的变量名，不显示任何变量值。

### 固定启动方式

装了多个 Codex 或 Claude、或者通过 wrapper 启动时，可以固定启动方式。参数逐个写，避免 PowerShell 丢引号：

```sh
nxbridge setup --claude-command my-wrapper --claude-command-arg launch --claude-command-arg claude
nxbridge setup --codex-home <配置目录>
nxbridge setup --clear-claude-command
```

- nxbridge 会把自己需要的参数接在命令最后。
- 设置时会通过这条命令查一次版本，只能确认它返回了可识别的官方版本号；最终启动的是不是官方程序，要在实际启动和登记时再核验。
- 启动后，nxbridge 只认 wrapper 启动出来的那个官方进程，不会把 wrapper 当成 Codex 或 Claude。
- wrapper 的配置目录无法自动确认时，需要用 `--codex-home` / `--claude-home` 指定。
- 已安装的一端要换到另一个配置目录，需先 `uninstall` 再重新 `setup`，避免改乱另一套配置。
- 启动命令里自带 `--settings`（JSON 或文件路径）时，nxbridge 把自己要加的几项（如 `crossSessionInbound`、`model`、`effortLevel`）合并进去，最后只传一个 `--settings`，你的环境变量、权限和 hooks 设置都保留。文件读不到或格式有误时直接报 `invalid_config`，不会丢掉你的设置继续启动。相对路径按后台搭档的项目目录解析，建议写完整路径。

### 后台 Claude 的两种运行方式

**原生后台（默认）：** 用 Claude 自己的后台模式运行。`nxbridge open claude` 直接接入这个会话。

**托管子进程（仅 Linux / WSL）：** 有的 wrapper 不允许 Claude 脱离它在后台运行，例如会拒绝 `--bg`、`--background` 和 `agents`。遇到这种情况，nxbridge 会改用一个独立的小进程，通过你设置的 wrapper 启动 Claude，并一直托住它。wrapper 全程是 Claude 的父进程，所以不违反它的限制。

- 这个小进程不依赖协调器，nxbridge 升级或崩溃都不会打断正在进行的工作。进程意外退出时，按下文“托管搭档自动恢复”用原会话 ID 自动重新拉起，不会重放旧消息，也不会多出一个会话。
- 这种方式没有界面。`nxbridge open claude` 会把会话交给你：Claude 空闲或在等你批准、回答时直接交接；正在工作时要用 `nxbridge open claude --interrupt` 先中断。交接时先停掉托管进程，再在你的终端里通过同一个 wrapper，按原会话 ID 打开。
- 交接时如果还有待批准的命令或待回答的问题，原生中断会把它们记为已拒绝，需要你在前台重新发起。
- 你退出前台会话，或者前台启动失败时，会话交还给 nxbridge；托管进程按原会话 ID 继续（已退出的按自动恢复重新拉起）。
- `status`、`watch` 和 Claude 状态栏会标明“托管子进程”，并在需要你处理时给出接手命令。
- Windows 暂不支持这种方式：要让进程脱离终端的 Job 对象，可能影响 Windows Terminal 和其他会话。Windows 上 wrapper 不允许后台运行时，会明确提示后台自动启动 Claude 不可用，已有的前台会话照常工作，消息保留不丢。

### 后台 Claude 的权限模式

**新启动的原生后台 Claude：** 以 `--permission-mode bypassPermissions` 启动；搭档 Codex 属于需要确认类或类别未知时，再用本次启动的 `--settings` 打开 `crossSessionInbound: accept`（Claude 只有 accept / hold / refuse，没有按来源放行的选项）。不写任何设置文件，不作用于用户窗口、接手或交还过的会话、已在运行的会话。

- **启动前提：** Claude 要求后台全部放行之前由用户本人接受过一次风险提示，只认所选配置目录的用户设置 `skipDangerousModePermissionPrompt: true`（或旧版 `.claude.json` 的 `bypassPermissionsModeAccepted`），`--settings` 和 `settings.local.json` 不算。nxbridge 只读检查；缺失时返回 `claude_bypass_consent_required`，不启动、不降级，保留原发送草稿，并在 doctor、setup/update 结果和选择框给出用户的一步：运行一次 `claude --dangerously-skip-permissions` 并接受。读不出设置时按“未知”报告，不当作缺失。
- **派活前核对：** 新会话第一份工作之前，后台必须拿到 Mod 登记的实际事实：原生权限模式为 bypassPermissions，或者模式未知（原生 SessionStart 不带模式）而引擎对一条不匹配任何规则的 Bash 探测命令的判定（`$.tool.check`，不运行、不弹窗）为 allow 且没有规则；需要接收设置时还要求实际生效值为 accept。已知的非全部放行模式、ask / deny、被托管或项目设置降级（`permissions.disableBypassPermissionsMode`）或接收设置被更严格的来源覆盖，都按明确的启动前提处理，同一会话重试，不重复启动、不带着需要人批准的模式继续。
- Linux / WSL 以 root 运行时，Claude 拒绝 `--dangerously-skip-permissions`（原生错误：cannot be used with root/sudo privileges），nxbridge 把它作为明确的启动前提报告（`claude_bypass_root_unsupported`），不设置 `IS_SANDBOX` 之类的绕过，也不降级为手动模式。

### 后台搭档的模型和推理强度

只作用于 nxbridge 自己启动的后台搭档。你自己打开的窗口不受影响，也不能在这里修改。

新建后台搭档时，模型和推理强度分开决定，每一项按下面的顺序取第一个有值的：

1. 这次创建时指定的值：AI 新建后台搭档（`select_partner` 的 `create`）时传入。命令行没有单独的新建命令；后台 Codex 和 Linux / WSL 托管子进程的 Claude 可以新建后用 `nxbridge partner-profile` 修改，Windows 原生后台 Claude 不能中途修改，要在新建时指定或用下面的配置默认值。
2. 配置 `partners.<codex|claude>.model` / `partners.<codex|claude>.effort`。
3. `partners.<codex|claude>.profile_source` 为 `frozen` 时已经记下的值。
4. 宿主自己的默认设置（Codex 的 `config.toml`、Claude 的 settings）。这也是不做任何设置时的行为。

**`profile_source`（默认 `host`）：**

- `host`：新建的后台搭档用宿主当前的默认设置。这份设置和你自己的 Codex / Claude 共用，默认模型一变（比如在别的地方切换过），之后新建的后台搭档也跟着变。
- `frozen`：改成它之后，下一个新建的这类后台搭档实际用上的模型和推理强度会被记下来，以后新建的这类搭档都沿用，不再跟着宿主的默认设置变。记的是宿主启动后报告的实际值，不解析 `config.toml`。新建时单独指定的值不会被记下：指定了模型的那个搭档整个不参与记录；只指定推理强度时，只记它实际用的模型。配置默认值实际生效后可以被记下。
- 记下的值存在 nxbridge 私有状态里，不写配置文件。`nxbridge config get`、`config list` 和 `status` 会显示记下的值和记录时间。
- 改回 `host` 会清除记下的值。想换成别的值，可以先改回 `host` 再改成 `frozen`，或者直接设 `model` / `effort`（设了的那一项优先）。
- 这个设置只管新建。已经在运行的后台搭档、接回的之前的会话，都按会话自己的设置接着跑；恢复和重启时沿用会话记录里的模型和推理强度。

**修改已有的后台搭档：**

```sh
nxbridge partner-profile codex --model <模型> --effort <推理强度>
nxbridge partner-profile claude --effort high
nxbridge partner-profile codex --reset
```

- AI 也可以用 `partner_profile` 工具查看或修改当前配对的后台搭档。选什么模型由 AI 和你决定，nxbridge 不内置模型列表，以宿主实际接受并报告的为准；宿主不接受时报错，不改用别的模型。
- 改动先记下，等搭档这一轮做完、空闲时才生效，不打断正在做的事。结果分项说明哪些已经生效（以宿主报告的实际值为准）、哪些还在等、哪些不支持。
- 换模型后，这个会话的提示缓存要重新建立，接下来几轮的花费会高一些。
- 后台 Codex：在同一会话里切换，从下一轮开始生效。
- 后台 Claude：托管子进程（Linux / WSL）在同一会话里切换；推理强度 `max` 只能在新建时指定，不能中途切换。原生后台（Windows 默认）暂时不支持修改已经在运行的会话，因为 Claude 能做到这一点的命令会同时改掉你所有新会话的默认模型；会说明原因，可以改为新建一个指定了模型的后台搭档。
- 宿主明确拒绝（例如模型名不对）时，搭档继续用原来的设置，结果里写明原因。切换结果不明（超时、断线），或者核对发现实际值和指定的不一致时，先暂停给它投递新消息，直到核对清楚或用 `--reset` 清除为止，避免它在既不是你指定、也不知道是什么的设置下继续工作。
- `--reset` 清除这个搭档单独记下的选择；正在运行的会话保持当前的设置，之后恢复和重启也沿用会话自己记录的设置。配置里的默认值只用于以后新建的搭档。
- 指定的选择跟着成员保存：后台掉线自动恢复、重启时都会用它，并核对宿主实际采用的值；不一致时停下报告，不用别的模型继续。
- 接手后交还：托管子进程交给你时，前台按当前固定的模型和推理强度启动。你在前台用 `/model` 或 `/effort` 改了，交还后台时沿用前台实际的值，并清除之前单独记下的选择。推理强度从 Claude 对 `/effort` 的原生回执里读取，不额外执行命令；读不出时只放弃推理强度这一项，由 Claude 自己决定，模型照常沿用，不暂停投递。
- Windows 原生后台 Claude 进程退出后，由 Claude 自己的后台管理服务按原会话重建，nxbridge 等它并按启动回执接回（同一句柄和会话、官方管理进程和程序）。最多等一分钟，超时停下并提示用 `claude agents` / `claude stop` 停掉卡住的原会话，不会另起副本。

### 托管搭档自动恢复

nxbridge 启动的后台运行时结束时，也会回收它的工具启动且尚未退出的子进程。需要长期保留的应用请从你自己的系统终端启动；POSIX 可使用 `setsid` 脱离运行，Windows 可通过桌面 Explorer 启动。

nxbridge 自有的后台会话（Codex App Server、原生后台 Claude、Linux 托管子进程）不论因为什么退出，都在现有 5 秒检查周期内发现，并记成一个持久的故障（incident）：按同一会话的这次掉线计，跨重连和协调器重启。

**快照与重新拉起**

- 发现时就把原程序、版本、配置目录、运行时和会话 ID 快照进故障记录，清理过期进程记录不会删掉它。
- 恢复按这份快照在同一会话重新拉起，不换会话、不换配置或供应商。
- 权限按会话自己最后一次的设置原样恢复（含会话中途改过的沙箱、网络、审批方式和审批人），不沿用启动时的默认配置；恢复前先以最严格的权限载入，核对一致后才投递。0.166 实测：会话中途改过权限后直接 resume，沙箱会退回启动默认值（可能更宽）。
- 宿主程序自更新后（Windows `.exe.old.<数字>`、Homebrew Cellar / Caskroom、Claude 原生安装器的版本目录），改用同一安装位置的稳定入口，启动前只读核验官方版本号，可能是更新后的版本；用户设置的启动命令或程序路径不做替换。

**重试与限额**

- 偶发失败最多自动 3 次（立即、30 秒、2 分钟），同一会话每小时最多启动 6 次。
- 次数在启动前于同一事务中扣除并持久保存，协调器重启、重新登记、睡眠或时钟跳变都不退还。
- 上一次启动结果不明（超时、可能仍有进程）时只核对、不再启动。

**前提不满足（`blocked`）**

- 启动前能查出的前提不满足时不扣次数，状态为 `blocked`，给出一步用户操作；之后在已有事件上只读重新检查，通过后接着恢复。
- 前提包括：目录未信任、本机代理不可用、需要 `bootstrap`、启动配置或命令缺失、原配置目录里找不到会话或已经变了、找不到原启动记录、无法确认 Codex 由 nxbridge 单独运行、同一会话正开在用户窗口里等待选择。
- nxbridge 不代授信任，也不改配置。

**用尽之后**

- 3 次用尽后，配对 AI 可用 `recover_partner`（`preview` / `retry` / `result`，需要 `incident_id` 和写明的理由）为同一故障申请额外一次，同样要通过前提检查、且没有未决的启动。
- 再往后需要用户在独立终端操作（如 `nxbridge open`）。

**就绪与通知**

- 就绪后稳定 60 秒才关闭故障。
- 恢复不自动开新轮次、不重放消息：掉线时有未完成工作的，给配对 AI 一条需要处理的通知（被中断的 turn、最后的工具、子代理线程、未决副作用、待送和不确定消息数），由它决定要不要发一条新的“检查进度后继续”；空闲时的单纯恢复只附加、不唤醒。
- 同一次掉线的投递告警、轮次健康、启动失败、配对丢失提醒合并为同一个故障，只提醒一次，进度只更新状态。

**归属与停止**

- 停止、释放、重启等破坏性操作仍要求证明 nxbridge 独占该运行时；共享 daemon 或无法证明的，一律不停止、不清理。
- Unix 上，nxbridge 让后台 Codex 监听 `~/.nxbridge/run/cx-*.sock`。Codex 0.167 起在所有 Unix 系统上都会把这个路径换成一个链接，指向 `realpath(/tmp)/codex-daemon-<euid>/` 下按原路径算出 SHA-256 的 socket，旁边的同名 `.lock` 用于启动互斥。按下面几条核验，全部成立才认定独占：
  - 原生参数带 `--no-daemon` 和同一个 `--listen`；
  - 链接目标正是按上游规则算出的路径，所在目录归当前用户、权限 0700，socket 权限 0600；
  - 记录的进程确实在监听这个 socket：macOS 用只针对该进程的 `lsof`，Linux 用 /proc 里的 socket inode 和文件描述符；
  - 核验前后进程代次和端点都不变。

  直接创建的 socket 走同样的监听核验；Windows 仍核对 AF_UNIX 的原生标记。以前存下的 `dedicated: false` 不直接采信，回收、重启时重新核验。
- 核验失败时，`retire` 的输出列出请求的路径（`requested`）、实际目标（`resolved`）、预期目标（`expectedTarget`）、预期进程和代次（`expectedPid` / `expectedGeneration`）、实际代次（`observedGeneration`），以及监听是否核验通过（`listenerVerified`），方便判断是不是误判。
- 回收后删掉 nxbridge 自己 socket 目录里的入口，包括早已失效的链接（用 `lstat` 识别，不跟随链接）。Codex 共享目录里的 socket 和 `.lock` 由 Codex 退出时自己清理；nxbridge 证明不了安全时不删，免得打乱正在启动的 Codex。
- `doctor` / `status` 的 `retirements` 每次按当前进程代次重新判断。`state` 有四种取值：
  - `alive`：进程还在；
  - `dead`：进程已退出；
  - `unknown`：无法确认；
  - `record-only`：没有已登记的可核验进程，仅剩未结算记录（不代表已证明进程不存在）。

  `currentReason` 是当前原因，`processes` 列出进程号、启动时间和状态，旧的失败原因放在 `lastFailure`。只读诊断不执行回收。
- 后台 Claude 的启动从没确认提交、也拿不到进程标识时，立即停止自动释放重试，保留记录供核对，可以用 `retire` 或恢复命令显式处理；之后登记上的进程照常核验。
- 重新拉起只要求是 nxbridge 启动的、没有接手租约、且该会话没有被其他存活成员加载。

**状态与关闭**

- 状态见 `status` 的 `partner.recovery`（`recovering` / `blocked` / `exhausted` / `unknown` / `ready`，`ready` 在稳定期内可见，`adopted` 表示接回了用户窗口）和 Claude 状态栏。
- 不想自动恢复时，`nxbridge off` 对应一侧或解除配对。

### 搭档会话被删除

- 判定：只认宿主原生给出的历史位置（Claude hook 的 `transcript_path`、Codex 的 rollout 路径），第一次观测到真实文件后，按“成员 + 会话 + 原配置目录”记下凭据。之后要同时满足三条才判为已删除：原配置目录可访问、记下的文件确实不在了、没有进程还在用这个会话。Codex 还要排除归档、压缩、正在关闭、刚建未写入等情况；收到原生 `thread/deleted` 事件也算已删除。权限或读写错误、整个存储不可用、历史被搬走或换了路径，都按未知处理。不会为了检测去恢复或新建会话。历史可能被改名搬到同一存储的任意位置，要证明“确实不在”只能读内容核对；存储里只要有一个读不出会话 ID 的记录（空文件、压缩副本、开头没有会话行），整个存储就判不出删除，按未知处理。这是有意的保守取舍，网络文件系统上的属性缓存也可能让判断滞后。有其他会话正在写入的存储里，完整核对经常被打断，会退避重试（最长 5 分钟），所以删除可能要过一阵才被确认。状态查询只读已有结果；打开或刷新搭档选择、执行恢复命令时会先重新核对，历史搬到新位置后在这些时候就能显示为可以恢复。
- 处理：原配对归档，历史保留，只停用被删的那一侧；解除记录只留在存活的一侧。同一个会话的原生记录重新出现时（比如被挪回原处），恢复前重新核验后可以用恢复命令接回原配对；记录不在期间，原搭档不出现在候选里。未完成的消息按原状态结清，结果不明的保持不明，不重放；原有的提问取消。
- 存活的一侧：有可用界面或状态未知时，提醒并给出搭档选择（新建、选择、取消、解除），不靠超时替用户决定。只有存活一侧是 nxbridge 自己在后台启动、仍在运行、并有原生归属证明（且不在前台或交接中）时，才算无人值守；窗口已关闭、进程已退出或经 SDK 的界面（桌面端、VS Code）都按未知处理，不自动新建。无人值守时每次丢失只新建一个搭档，重启后沿用同一个待建成员；用户关闭了 nxbridge、暂停了协作、拒绝过自动新建或已经解除配对时，不新建。新建失败会记录原因，并有限次退避重试。如果新建请求已经发出、但还没确认新会话的身份就超时或中断，结果按“不明”记录并显示原因，不再自动发第二次新建；等新会话通过可信的原生登记确认身份后，沿用这个会话继续。目前不会主动去找可能已经建出来的会话；新建请求刚发出后台就崩溃时，Codex 那边建出的线程不会被自动认领，配对会一直停在“待确认”，需要用户解除配对或另选搭档。确认身份之后的启动重试仍沿用同一个待建成员和会话。
- 新搭档：全新身份，拿到原配对 ID、CURRENT 路径（如果有）、有上限的最近往来快照和未结消息编号，并注明来源；不假装旧消息已经送达，也不自动重放任务。

### 接手是临时租约

`nxbridge open` 不会把成员改为用户所有，接手期间仍由 nxbridge 托管，只另记一个临时租约。

- 原生接入核验成功前不算接手。
- 接入失败或接手的 TUI 退出时，都走同一个返还流程：CLI 正常结束时直接返还，CLI 被杀时由协调器观察到后返还。
- 后台仍在运行的，直接恢复正常投递；已退出的，进入上面的自动恢复。
- 接手期间，同一 App Server 上的投递照常。

### 会话在窗口与后台之间转移

一个 Codex 会话可以在你自己的窗口（ChatGPT 应用 / daemon、`--no-daemon`、`nxbridge codex`）和 nxbridge 后台托管之间来回转，始终是同一个会话 ID、同一个成员、同一组配对，上下文、消息编号和回复关联都不变。

**每组配对记一个托管归属**

- 后台：会话本来就是 nxbridge 在后台开的，或者你明确选过“转到后台”（`adopt`、或选择框里的“在后台继续原会话”）。之后窗口关掉，自动在后台按原会话继续，不再问。
- 你的窗口：会话本来是你自己开的，或者你明确选过 `release`。窗口关掉后配对保留、消息留着，不会自动拉到后台。
- `nxbridge open codex` 是临时接手，不改归属：关掉窗口就交还后台。
- 只读到会话 ID 不算同意：nxbridge 不会因为看到同一会话就把你的窗口接到后台。

**窗口关了、归属是你的窗口时**

配对不结束，Claude 发的消息保存下来。下次发信时选择框给四项：

- 在后台继续原会话：同时记为后台归属，以后关窗也自动转后台。
- 等我重新打开窗口：用任意方式重新打开这个会话后送达，之后发信不再弹选择框。
- 关掉选择框只是这次不选：消息留着，下次发信再问。
- 新建后台 Codex：新开一个，看不到原会话的上下文；没送到的消息按换绑规则作废，可由 AI 重发。
- 解除配对。

**转到后台（`nxbridge adopt codex`）**

持有者核验只覆盖本安装已登记的窗口和后台；没有加载 nxbridge 插件或使用其他配置目录的进程不在观察范围内。

- 不带参数时作用于本组配对的 Codex 会话；`--session <会话ID>` 可指定任意会话，只有一组历史配对用过这个会话时自动接回那组配对，多组时让你选。
- 要在独立的交互式终端（Terminal.app、Windows Terminal 等）里运行；在非交互环境运行会报 `user_terminal_required`，并提示改用系统终端，或在 Claude 发信后出现的选择里选“后台继续原会话”。
- 会话还开在你的窗口里时，先记下“后台”归属，等窗口确认关掉后再转；占用者无法确认（例如看不到的私有 App Server）时拒绝，并点名是哪个进程。不会替你关窗口。
- 有待批准的操作或没收尾的任务时先不转，状态里说明要做的一步。
- 转时只启动属于这个成员的专用 App Server，用 `thread/resume` 打开原会话，不改会话名、模型和推理强度；权限按上面“托管搭档自动恢复”的规则原样恢复，核对一致前不投递。
- 原权限读不到时，后台先不给文件和网络权限、操作都要审批；只读到一部分时，读到的部分照原样，其余按最严格处理；某条规则没法原样套用时换成更严格的写法。这些情况都会在结果和状态栏里写明，要放宽请按 Codex 正常方式设置。
- 中途协调器重启时，重启后重新核验再继续，不会跳过权限核对直接投递。

**长期交给自己的窗口（`nxbridge release codex`）**

- 先记下“你的窗口”归属，等后台空闲（不强行中断）、确认后台进程已经退出，才告诉你可以打开，避免 Codex 提示“会话已在别处打开”。
- 之后后台不再自动恢复，协调器重启也不会；你用任意方式打开这个会话，就接回原成员、原配对。
- 已经在 `open` 的临时窗口里时，`release` 直接把它改成长期，不用关掉重开。
- 有待批准的操作时先不停：用 `nxbridge open codex` 打开原会话处理后再 release。

**打开方式与唤醒**

- 普通包装窗口使用官方原生运行方式；明确指定会话 ID，且它已加载在自有后台时，才接入那个后台。已加载的托管搭档按临时接手处理，不会再起一份竞争的运行时。
- 用户会话在 nxbridge 运行时里时，协调器只在有事要做时订阅这个线程：本轮任务、待批准或待回答、排队中的唤醒或投递。空闲后在下一轮服务循环（约 5 秒）退订；只观察时用 `thread/read`，不为观察而 `thread/resume`。按线程串行处理订阅、投递和唤醒，避免在读取和提交之间退订。
- nxbridge 启动的运行时一律带 `thread_unload_delay_secs=0`（不改用户配置），最后一个订阅退出后立即卸载线程、释放写入锁，`codex.cmd`、ChatGPT 应用等随即可以打开同一会话。释放不依赖包装的退出清理，直接关掉终端窗口也一样；包装退出时会额外清扫本端点上空闲的用户订阅，只清理空闲的，不把仍开着的其他 TUI 线程标成离线。
- 退订检查按线程在后台各自进行并去重，不阻塞服务循环的其他阶段。
- nxbridge 启动的运行时在运行时记录里标明卸载延迟为 0。在这类运行时上，nxbridge 退订后线程仍未卸载，就说明还有别的客户端订阅，窗口保持在线。
- 用户窗口能否被主动唤醒取决于打开方式：daemon 窗口只拉不推，用户亲手选择且核验到活着的终端时除外（有限唤醒，见下文）；只拉不推时要在窗口里有操作才会取消息，用户可以输入 `nxbridge pickup` 专门取件；状态和发信结果会写明。需要随时被叫醒时交给后台。

**同一会话被手动 resume**

用户在自己的窗口里打开托管会话时，登记为观察成员，不夺取所有权。

- 托管副本已确认退出、同一配置目录、只有这一个候选时，直接接回原成员：同一配对，消息编号和回复关联不变。归属是后台的，这是临时接手租约：用户窗口退出后交还后台，需要时由自动恢复重新拉起。
- 托管副本仍在运行时，先停止向托管副本投递、退订 nxbridge 自己的线程，再由用户选择，避免同一会话两处运行。
- 其他情况由用户选择。nxbridge 自己重新拉起的后台进程不会被当成用户窗口；后台 Codex 自己开的子代理线程也不算这个会话在别处打开，不会因此停止投递。

这几种情况都不会隐式新建对端后台搭档。同一会话里没提交过的消息继续投递；只有目标会话真的变了，才作废并说明。新建后台 Claude 前，先只读检查项目信任等确定性前提，不满足时不建立配对，草稿保留。

## Codex 共用后台服务（daemon）

Codex 0.166 默认开启 `daemon_auto_start`，所有平台都一样：不带参数运行 `codex` 时，会话、hooks 和 MCP 都在用户的共用 daemon 里运行，TUI 只连到它。

以下情况仍在 TUI 进程内运行（embedded）：提权 Windows、WSL 的 `CODEX_HOME` 位于 DrvFS/9p、`--no-daemon`、`--profile`、`-c` 覆盖非功能开关配置等。包装窗口和 `nxbridge codex` 默认按这些原生规则运行，保留原生更新提示；nxbridge 自有后台才关闭启动时的更新检查。

### 身份

- daemon 窗口按 Codex 配置目录 + daemon 本次运行的代次 + 原生线程 ID 登记，从不把 daemon 或 MCP 进程号当成窗口。
- 官方接口无法给出 TUI 与线程的对应关系，所以 daemon 下配对跟线程走。
- 隐式创建后台搭档之前，先只读查询 daemon 上已加载的交互式根线程，同目录的会按现有配对规则成为候选。

### 投递：只拉不推

对 daemon 线程只拉不推：不调用 `queue/add`、不 `thread/resume`、不开新的 turn、不长期订阅。

- 原因是官方 daemon 会自行消费输入队列，即使没有窗口在看也会开新的 turn，订阅还会阻止线程按时卸载。
- 消息持久保留，等线程自己在原生 hook 或 `receive_messages` 时取走，忙碌和空闲都一样。
- `--no-daemon` 保留原有的主动唤醒和窗口连续性。

**例外：有限唤醒（`delivery_mode: daemon-direct`）**

适用条件（同时满足）：

- 仅限用户亲手在选择框、配对码或终端里选定的配对（历史配对和自动配对不算）；
- 线程当前已加载且空闲；
- 经核验有同一 `CODEX_HOME`、走共用 daemon 的 Codex TUI 进程在运行（各平台做法见下文“平台范围”）。

满足时用与专用投递相同的 `thread/inject_items` 工具调用/结果对 + 空输入 `turn/start` 唤醒，不 resume、不订阅，回执仍按 rollout 严格解析，确认前保持 queued、未读。

剩余风险：已加载线程列表和 `canAcceptDirectInput` 都证明不了有 TUI 在看（关闭的窗口在卸载前仍可接收输入，空 turn 照样会跑）。所以用户关了所选窗口但同一配置目录还开着别的 Codex 窗口、线程尚未卸载时，可能有一轮无人观看地运行，结果留在该会话历史，回复照常送回 Claude；需要审批时停在等待审批，不会自动批准，状态显示需要人工处理并点名会话。

平台范围：三个平台都只认走共用 daemon 的交互式 TUI，排除 `--no-daemon`、显式 `--remote`、`exec` / `review` / `login` / `mcp` / `app-server` 等非交互子命令；直接带初始提示词启动的 `codex <提示词>` 算 TUI。

- Linux / WSL：读 /proc：程序名、参数、进程环境里的 `CODEX_HOME`（相对路径按进程当前目录解析），标准输入输出是终端，核验前后启动代次不变。
- Windows：由原生身份助手读取进程自己的 `CODEX_HOME`（从进程环境块读取，相对路径按进程当前目录解析），并核验标准输入和输出确实是控制台（`\Device\ConDrv`），重定向到管道或文件的不算；查询期间持有同一代次的进程句柄，不附着控制台。已在隔离的 Codex 0.166 上实测核验通过，经共用 daemon 实际唤醒还没有在 Windows 上实测。
- macOS：只对候选进程和 daemon 进程运行 `ps` 和 `lsof`，不做全局扫描，也不读进程环境：标准输入输出是终端，并且它有一个 unix socket 连到这个配置目录的 daemon 监听地址（先解析成真实路径再比较），核验前后启动代次不变。已在真机上验证通过（macOS 27.0、Codex 0.167.1 / 0.167.2）：空闲窗口 8 秒内被唤醒，daemon 自动升级、终端重连后同样能唤醒；关掉的窗口、`/new` 后、`--no-daemon` 窗口都不唤醒。

核验粒度和 Linux 一样：证明的是“这个配置目录有一个活着的终端连在 daemon 上”，不是“这个窗口此刻正显示这个会话”。展示用的核验结果缓存 1 秒，真正写入和续跑前都重新核验。

**取件口令：** 只拉不推时，用户在 Codex 输入框里提交 `nxbridge pickup` 或 `nxbridge 收信`，`UserPromptSubmit` hook 会附上一段说明：这只是取件触发，不代表回答了选择、任务或批准任何操作，同时附上正常的取件提示。宿主不允许 hook 替换用户输入，所以这句话仍会留在 Codex 的对话历史里。

**窗口已经关了时：** 状态和发信结果带上 `delivery_wait.resume_command`（`codex resume <会话ID>`），提示先在原项目目录的终端重新打开同一会话，再取件。`open_command` 只用于 nxbridge 自有的后台。重新打开后，只要是同一组明确选过的配对、同一个会话，窗口空闲、刚核验到活着的终端，绑定和端点也没变，就直接送入，不用再输入取件口令。`/new` 和换到别的会话不继承这份授权。

**等待取件时的状态**

- 不满足条件时，等待取件期间发送结果为 `waiting_native_input`（空闲）/ `waiting_native_interaction`（忙），`delivery_state` 仍是 accepted。
- 状态和 Claude 状态栏带 `delivery_wait` 点名目标窗口与待取条数，明确未送达；选择框候选标注 `daemon-pull`。
- `contract_inactive` 对 daemon 线程只建议在原窗口有一次原生交互，不建议重开或重启。

### `/new` 与 fork

daemon 下 `/new` 不会卸载原线程，所以有限唤醒另加一道保守门槛：

- 每次唤醒前和每次配对变更时都只读扫描已加载线程。同一配置目录、同一项目里出现比已选线程更新的交互式根线程（`/new` 后、新对话还没输入时就能看到），或者原生 SessionStart / 真实用户输入落在别的根线程上，就把已选线程视为可能已被取代。
- 此时暂停对它的唤醒，`delivery_wait.state` 为 `context_changing`，点名原会话并建议在要用的对话里输入 `nxbridge pair`；消息保留，不自动转给新线程，也不自动改配对。
- 用户在原线程亲手输入一次，或重新明确选择后才恢复唤醒。
- 代价是同一项目里另开一个 Codex 窗口也可能让原线程暂时只拉不推。子代理线程和其他项目不计入。

配对何时结束、何时继承：

- 原线程收到官方结束或卸载信号后，配对不结束：成员标为窗口已关闭，消息保留，按上面“会话在窗口与后台之间转移”处理，不自动转给新线程；新线程是普通候选。没开始过对话（没有会话 ID）的窗口退出时仍解除配对。
- fork 只在有明确的 fork 来源、父线程已正式结束、且恰好只有一个符合条件的后继时才继承配对；父线程还在时，不会被 fork 抢走配对。

### 权限分类

MCP、hook、专用 App Server、共享 daemon 共用一个 Codex 分类器，只认属于当前运行时（同线程、同代次）的证据：

| 证据 | 类别 |
|---|---|
| read-only / workspace-write（含 approval=never）、on-request / untrusted、原生报告 `auto_review_enabled=true` 或实际运行策略的 `approvalsReviewer` 为 `auto_review` | prompting |
| danger-full-access + never 且没有有效自动审查 | bypass |
| 只有 `_meta` 的 danger-full-access（不带 approval_policy），或只有 `approvals_reviewer` 配置值 | unknown，不从沙箱猜测 |

### 非全部放行模式

- unknown 类别在写入原生 inbox 前不拒发，省略 `from-mode` 交给 Claude 原生准入（prompting 接收方照常进入上下文，bypass 接收方会暂扣并经 held 回执报告）。
- 确有阻碍时 actor status、send 结果、配对候选带 `permission_guidance`（`class_mismatch` / `sender_unknown` / `held` / `refused`，含两端类别），Mod 据此给出这组配对的一步操作，不写用户设置。
- `delivery_wait` 覆盖任何 Codex 等待人工和尚无线程的新窗口：`reason` 为 `native_approval` / `native_input` / `awaiting_first_prompt` / `native_context_changed`；nxbridge 自有的存活后台 Codex 另带 `open_command`。
- 不带选择参数的 `nxbridge open codex` 只在当前项目里自有、等待人工的 Codex 中选：唯一时直接打开原会话，可看到原样的待处理审批并由用户在原生表单作答（同 turn，不中断、不重跑）；多个时按名称编号选择。
- `native_issue`（`tool_failed` / `approval_denied` / `sandbox_denied`，只带有界元数据）是观察到的工具事实，不代表任务结论。
- 审批结束后，只有经核验属于当前轮次、对应请求或工具的完成事件才解除等待人工。
- 纯 MCP 交互（没有 Mod）时立即提示原生 `/reload-plugins`。

### nxbridge 自有后台 Codex 的启动权限

nxbridge 新启动的后台 Codex 不需要人批准，同时与配对的 Claude 保持同一类：Claude 为 bypass 类时用 danger-full-access + never；Claude 为 prompting 类时用 on-request + `approvalsReviewer: auto_review`（由 Codex 的审查模型代替人批准提权，类别仍是 prompting）。只用启动参数，不写 `~/.codex/config.toml`；第一轮之前核对原生实际生效的策略并持久化，之后恢复、重启沿用这份记录；审查方式被拒或被忽略时，只在开始任何工作之前改用 full access。用户窗口、接手或交还过的会话、已在运行的会话不受影响。

### nxbridge 自有后台 Codex 的连接

实测 0.166 的共用 daemon 会接管同一配置目录下经 Unix socket 启动的 App Server（`--no-daemon`、`-c features.daemon_auto_start=false` 都无效），后台 Codex 的生命周期因此归 daemon。

**Linux / WSL 和 Windows：** 官方 `codex app-server --help` 同时列出 `--ws-auth` 与 `--ws-token-file` 时，nxbridge 改用带令牌认证的本机回环 WebSocket 启动专用 App Server。

- 监听 `127.0.0.1` 随机端口，令牌为 32 字节随机值。
- 实测未认证连接被拒绝，已加载线程与同目录共用 daemon 互相独立，停止专用进程不影响共用 daemon 及其线程。
- 令牌文件只有当前用户可读（Linux 0600，Windows 沿用 nxbridge 私有目录权限），只经子进程环境传给 `open` 和包装启动的客户端，不出现在状态、参数和日志里，也不改用户配置。
- 没有这两个参数的旧版本仍用私有 socket。

**macOS：** 在 Mac 上验证前保持私有 socket，可能仍由共用 daemon 承载：nxbridge 不停止它，掉线后照常按原会话重新连接或拉起。验证步骤见安装包里的 `tools/macos-validation.md`（只读、不调用模型）。

已在运行的后台进程沿用原连接，下次重新拉起时才切换。

### 归属

daemon 永远归用户，nxbridge 不停止、不重启、不更新它；`restart codex`、`recover codex` 不作用于 daemon 线程，中断和重开需要在原窗口操作。

## 配置与状态

### 配置文件

nxbridge 的配置放在私有目录（默认 `~/.nxbridge`，可用 `NXBRIDGE_HOME` 指定）里的两个 TOML 文件中。

- `NXBRIDGE_HOME` 是唯一会影响配置的环境变量，其他设置都不读环境变量，避免“到底继承了谁的环境”这类问题。
- 两家 CLI 仍然遵守它们自己的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`。

| 文件 | 谁来写 | 说明 |
|---|---|---|
| `config.toml` | 只有你手写 | nxbridge 永远不改它；注释、顺序、BOM、换行符都原样保留 |
| `config.managed.toml` | `setup` 和 `nxbridge config` | 程序生成，格式会被重写，不要手改 |

优先级：默认值 < `config.managed.toml` < `config.toml`。

示例 `config.toml`：

```toml
schema_version = 1

[hosts.claude]
command = ['my-wrapper', 'launch', 'claude']   # 后台 Claude 也走这个 wrapper

[questions]
timeout_ms = 600000

[retention]
max_references = 1024
```

### 主要配置项

| 键 | 说明 | 类别 |
|---|---|---|
| `questions.timeout_ms` | 搭档问题从创建到结束的等待时间，默认十分钟 | 普通 |
| `retention.*` | 事件、消息、问题、引用快照、日志的保留期限、数量和大小 | 普通 |
| `collaboration.implicit` | `never` 关闭自动创建后台搭档 | 敏感 |
| `collaboration.compatibility_wake` | `strict` 不通过 user turn 唤醒 embedded 会话 | 敏感 |
| `collaboration.subagent_send` | `deny` 要求所有外部通信由主会话完成；Codex 子代理不论此项都不能对外通信 | 敏感 |
| `hosts.{codex,claude}.command / binary / home` | 启动命令、程序路径、配置目录 | 敏感 |
| `hosts.codex.endpoint / auth_token_env` | 现有 App Server 地址；认证 token 所在的环境变量名（只存名字，不存值） | 敏感 |
| `partners.{codex,claude}.model / effort` | 新建后台搭档默认用的模型和推理强度；不设时跟随宿主自己的默认设置 | 敏感 |
| `partners.{codex,claude}.profile_source` | `host`（默认）跟随宿主当前设置；`frozen` 记下下一个新建搭档实际用的模型和推理强度，以后新建都沿用 | 敏感 |
| `hosts.claude.sdk_user_prompt` | 默认 `false`。设为 `true` 时，经 Claude SDK 提交、又不来自 Claude 桌面端或 VS Code 的主会话输入（例如 Paseo 这类自带界面的工具）也算本人输入，用于 nxbridge 的新工作阶段、解除中断，以及用户活动和空闲判断。Claude 本身照常处理这些输入，与这个设置无关。每次遇到这类输入时重新读取配置，改完从下一条输入起生效。配置确认、开关和配对仍只认原有的本人来源，被拒时提示改用系统终端的 `nxbridge` 命令。打开后，脚本或工具通过 SDK 运行的 Claude（如 `claude -p`）发出的输入也会算作本人输入 | 敏感 |

协作提醒的阈值 `collaboration.sync_tip_minutes`、`collaboration.idle_notice_minutes` 见“协作提醒与异常检测”。

### 命令行查看和修改

```sh
nxbridge config list
nxbridge config get retention.max_references
nxbridge config set retention.max_references 2048
nxbridge config set hosts.claude.command '["my-wrapper","launch","claude"]'
nxbridge config unset retention.max_references
```

- 数字和命令数组用 JSON 写法，普通字符串直接写。
- `unset` 会恢复默认值，或你在 `config.toml` 里写的值。
- 某一项已经写在 `config.toml` 里时，`set` / `unset` 会拒绝修改，并告诉你它在哪个文件第几行，避免出现“改了却没生效”。
- `config list`、`status`、`doctor` 会显示每项的实际值和来源。
- nxbridge 正在运行时，`set` / `unset` 保存后会通知协调器立即读取新配置，不用再运行 `nxbridge reload`；协调器没在运行时会如实说明。
- 直接编辑 `config.toml`（以及 `config.managed.toml`）也一样：协调器约每秒只看一次文件属性，发现变化就重新读取，不用运行 `nxbridge reload`。文件写了一半或格式有误时继续用上一份有效配置，错误记为 `configuration.reload.failed` 事件，`nxbridge status --json` 的 `configurationReload` 也会显示；改好后自动生效。
- 启动方式相关的设置只对之后的启动生效；因配置问题停下等待的后台会立即重新核验。

### 在 Claude / Codex 里修改

两边都有一个 `config` 工具，可以直接让模型帮你看或改配置：

- 查看所有配置、修改普通项：模型直接完成。
- 修改敏感项：模型只能提出改动，拿到一个改动编号和具体差异，不能自己让它生效。你需要在同一个窗口里亲手完成两步：
  1. 输入 `nxbridge config pending`（Claude 里是 `/nxbridge config pending`），查看差异和一个只显示给你的确认码。
  2. 输入屏幕上给出的确认行。
- 确认保存后立即生效，并重新核验因配置问题停下的后台。在别的窗口查看时，会说明提案是在哪个窗口提出的、还剩多久。提案、查看、确认、拒绝和过期都会记事件，不记确认码。
- 确认码十分钟内有效，只能用一次。改动被新提案替换、nxbridge 重启、会话结束，或者配置文件在这期间被改过，确认码都会作废。
- 确认码不会出现在模型能读到的任何内容里，所以模型没法替你确认，也不应该替你运行这两步。
- Codex 端要求 nxbridge 的 hooks 已经在 `/hooks` 里信任过并且已加载。nxbridge 不会替你信任 hooks，也不会改审批或沙箱设置。
- 在 Claude 输入框里亲手输入 `/nxbridge config set <键名> <值>` 或 `unset`，可以直接修改，敏感项也一样，不用再确认。

### 修改来源的限制

- 命令行的 `nxbridge config set/unset` 只接受独立的交互式终端。从 Claude 或 Codex 会话里发起（包括 `!` 命令和模型执行的命令）会被拒绝，要用上面的 `config` 工具。
- Claude 桌面端和 VS Code 由应用代为提交用户在界面里的输入，宿主把来源标为 `sdk`。Mod 在会话画在 desktop / vscode 界面上时，把这种输入当作本人输入（配置查看和确认、`/nxbridge on`、配对码、解除中断暂停）；没有界面的 `claude -p`、子代理、搭档来信、插件、Claude Code 定时任务（`/loop`、计划任务）和 Remote Control 都不行。被拒时只记来源和界面，不记参数。官方文档没有写明桌面端的来源标记，这条按宿主接口推定，还没有在桌面端实测；桌面端应用自己的计划任务如果也以 `sdk` 来源提交，会被当成本人输入，这一点同样没有实测。
- 打开 `hosts.claude.sdk_user_prompt` 以后，没有桌面端或 VS Code 界面、来源为 `sdk` 的主会话普通输入（比如 Paseo 这类第三方界面）也算本人输入，用于 nxbridge 的新工作阶段、解除中断，以及计入用户活动。Claude 本身照常处理这些输入，与这个设置无关。配置查看和确认、开关、配对码不受这个设置影响，被拒时会说明这一点，并提示改用系统终端的 `nxbridge` 命令。子代理和搭档来信不论这个设置如何，都不算本人输入。
- 在 Claude 桌面端自带的终端面板里运行命令行写入也会被拒绝（它继承了 Claude 会话的环境）；用系统终端，或在 Claude 输入框里用 `/nxbridge config`。
- 这是 nxbridge 自己修改入口的防护，不是系统级隔离：完全权限模式下，模型本来就能以你的身份直接改文件。
- 敏感项的配置文件里不存放任何密钥。命令参数里常见的密钥写法会在诊断输出中隐去，但无法保证任意参数都能被识别，不要把 token 写进启动命令。

### 配置有误时

- TOML 有语法错误：报出文件名、行号和列号，nxbridge 不会启动，也不会覆盖文件。
- 不认识的键：只警告，原样保留。

### 本地保存的内容

- 消息与问题正文、nxref 展开和取件快照、子代理最终答复、压缩后补回的最近往来消息，是功能需要的明文，受 `retention.*` 约束（默认 7 天，并有数量和大小上限；未完成的消息及其祖先链会保留）。
- 健康跟踪只保存轮次、时间戳、状态、工具编号和有长度上限的错误文本。
- Codex 一轮内容的变化只用私有的 SHA-256 判断，不在内存、`status` 或事件里保留原文；事件只写白名单字段。
- 真实进展时间和状态转换仍按原值立即持久化。
- broker 与 Codex 日志在运行中也按大小轮换，已退出运行时的旧文件会被清理。
- 后台启动记录的保存方式见“启动方式的选择”。

### Codex hook 超时

Codex 0.164 起（含 Mac 上的 0.167）对 `SessionEnd`、`Interrupt` hook 的超时上限是 3 秒；其他事件按声明的 10 秒。

- 插件声明为显式 3 秒（不能省略，省略时 Codex 只给 1 秒）。Codex 的信任哈希包含整个插件目录的内容指纹，所以插件更新后每个配置目录要重新信任一次全部 hooks。
- hook 入口先启动总时限保护，再读 stdin：`SessionEnd`、`Interrupt` 在 2.7 秒、其他事件在 9.4 秒时输出一次结果；输出已经开始时最多再等 150 毫秒写完，不截断 JSON。时限从第一个 hook 进程（`bridge.cjs`）启动算起。这是计时器上限，系统极忙时进程调度仍可能让实际结束晚于它（并行单元测试里见过 3.2 秒）。
- 时限到期按失败处理：nxref 展开被拒绝，`nxbridge on/off/status` 返回“结果尚未确认”，nxbridge 的唤醒提示被拦下（`continue:false`），其他事件返回空结果。除 `SessionEnd` 外，输出里附 `systemMessage`：`nxbridge hook timed out after <3|10>s; result unconfirmed`，Codex 显示为警告，hook/completed 里是一条 Warning；`SessionEnd` 不读输出，改为退出码 1 并把同一句写到 stderr。协调器把这两种都记为 hook 超时证据，沿用原有的连续超时提醒。不用退出码 2：Codex 会把 stderr 当作拦截理由，`PostToolUse` 交给模型、`Stop` 变成继续提示。
- 日常路径：hook 进程只读 stdin、检查成员是否已关闭，然后通过 `hook.client` 把原始输入、自己的 PID、`CODEX_HOME` 和 cwd 交给协调器，不加载身份查询和完整 IPC 代码。协调器从这个仍在运行的 hook 进程向上找 Codex 进程（跳过 hook 自身，最多 10 层）：Windows 用协调器常驻的身份助手（每次查询仍取新句柄，不缓存身份；单次查询超时只让这一次失败），Linux 读 `/proc`，Mac 用 `ps`。之后在协调器进程内执行原有的登记和 hook 流程，预算同上（短事件 2.3 秒）。
- 回退：令牌读不到、连不上协调器、协调器是旧版（`unknown_method`）或身份助手不可用，都发生在执行之前，改走完整路径；进入执行后的错误统一报 `hook_execution_failed`，不回退、不重放。通知回执用一次性收据，在 hook 写完输出后确认，10 秒过期。
- 原生 hook 登记时，后台归属检查在同一次请求里只做一次。跳过重复检查的标记只在协调器内部传递，IPC 无法设置。
- 耗时观测：协调器从已接入会话的 hook/completed 记录 Codex 实测的 `durationMs`，每个成员保留最近 40 次；`nxbridge status --json` 的 `capabilities.hookTimings` 按事件给出次数、最近一次、p50、p95 和最大值。没有接入的窗口（用户自己开的原版窗口）没有这项数据；`capabilities.hookObserved` 是 nxbridge 在进入协调器前自己测到的部分耗时，不含 Codex 启动 hook 的时间。
- Windows 测量（p50/p95，毫秒；从直接启动 Node 进程算起，不含 Codex 外层的命令行外壳）：机器较空闲时 `SessionEnd` 154/239、`Interrupt` 183/243；机器很忙时 `UserPromptSubmit` 630/985。这组数字测的是命令 hook 本身。测量时 nxbridge 这一侧剩下的固定开销，主要是插件命令 `node bridge.cjs` 启动 Node 的约 90 毫秒。`PostToolUse` 不启动进程，见下面“hook 与 Mod 的快速路径”。
- Codex 运行每个命令 hook 都先启动会话的命令行外壳：Windows 通常是 `powershell.exe -NoProfile -Command`，没检测到外壳时是 `cmd.exe /C`；macOS/Linux 是 `<shell> -c`，没检测到时是 `$SHELL -lc`。这部分由 Codex 决定，不在上面的数字里。Windows 隔离探测（同一个 `bridge.cjs`，各 3 次取中位数，机器较空闲）：直接启动时 146 毫秒；经 `powershell.exe -NoProfile -Command` 启动时 423 毫秒；PowerShell 加一个空 Node 脚本本身就要约 430 毫秒。原生测试里 Codex 记录的 1.4–1.8 秒，是负载较高时一个只输出标记的极简脚本的整次耗时，包含外壳和宿主开销，各部分没有单独拆分；那次测试只验证输出格式和超时识别，不代表 nxbridge hook 的耗时。

### hook 与 Mod 的快速路径

**Codex `PostToolUse` 走 MCP**

每次工具调用后都会触发 `PostToolUse`。插件声明里只有这一项是 `mcp_tool`：Codex 直接调用已经连着的 nxbridge MCP 服务上的一个隐藏入口，不启动任何进程。这个服务和提供 `claude.*` 工具的是同一个进程，隐藏入口不出现在模型的工具列表里。

- **身份**
  - 每次调用时，协调器都从这个 MCP 服务的进程向上重新核验所属的 Codex 进程和代次，不缓存身份。
  - Codex 自己附带的 `_meta.threadId` 要和这个线程自己的 rollout 记录对得上。
  - 主线程和独立的分叉线程都按核验过的进程身份精确对应成员，各自执行自己的 hook 业务。
  - 原生子代理事件里的 `session_id` 仍是主线程的，它的 `PostToolUse` 核验后什么都不做，不会碰主线程的登记和消息。
- **时限**：连接、身份核验和业务处理合用自己的 9 秒上限。协调器超时以后，后台健康恢复会拦住后续调用，不会每次工具调用都等满一次超时。结果不确定时不重放。
- **出错时**：`isError`、超时或服务不存在都不会拦下工具调用。MCP 服务进程崩溃以后，本会话后面的 `PostToolUse` 会立刻失败，Codex 不会自动重连。这一轮剩下的时间里，收不到中途的新消息提示和工具进度，要到下一个命令 hook（下一轮的 `UserPromptSubmit`，或重新打开后的 `SessionStart`）才恢复。
- **仍是命令 hook 的**：`SessionStart`、`SessionEnd`、`Interrupt`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`PermissionRequest`，以及只匹配 `spawn_agent` 的 `PreToolUse`。原因是：
  - 启动时 MCP 未必已经连上；
  - Codex 0.164 不支持 `SessionEnd` 走 MCP；
  - `Interrupt` 的时限很短；
  - 每轮的命令 hook 要保留，作为 MCP 出问题时的恢复入口。
- **版本要求**：`mcp_tool` 从 Codex 0.148 开始支持。更早的版本会因为不认识它而拒绝整个 hooks 文件，nxbridge 的 hook 就全部失效。所以安装和更新要求 Codex 至少 0.164.0，即已实测的最低版本，过旧时拒绝并提示升级。
- **实测**：每个事件的原生 `durationMs` 中位数如下。
  - Windows / Codex 0.164，完整业务：约 30–40 毫秒。
  - WSL / Codex 0.169：约 65–78 毫秒。
  - WSL / Codex 0.170，机器很忙时 MCP 路径的 8 次 hook 中位数约 265 毫秒。

**取件提示的两道保险**

- **按进程身份找成员**：同一个 Codex 会话如果还留着一条离线的旧记录，按会话 ID 查找会命中两条，判为“无法确定”。因此 hook 先按核验过的上下文进程和代次，在活动端点里找成员，找不到才退回按会话查找。两个都活着的候选同时匹配时，仍判为无法确定。
- **失败会报出来**：hook 到协调器的失败会记录下来，按 60 秒限频，并计入健康检查。只有身份核验通过以后才计入。客户端本来就会改走完整路径的那几种错误码不计入。
- **工具结果附带提示**：Codex 调用 `claude.status`、`claude.send_message`、`claude.checkpoint` 时，如果有待收的消息，结果里附带一句取件提示。
  - 每轮只提示一次。
  - 已关闭的成员和子代理不提示。
  - 提示本身出错，不会让一次成功的发送变成失败。

**Claude 一侧**

- 启动和退出两个 hook 用直接执行的形式（`command` 加 `args`），不经过命令行外壳。Windows Claude 2.1.327 实测启动 hook 为 81 毫秒。启动时的 `SessionStart` 只支持命令 hook，所以是命令。
- Claude hook 也走 `hook.client`：协调器用常驻的身份助手核验 hook 进程的上级，再对照官方的 `sessions/<pid>.json`，核对会话和代次。
  - 协调器启动时就在后台准备好身份助手，有 10 秒预算，不占用 hook 的时限。
  - 身份查询阶段的错误、空的消息 socket、网络共享或相对路径的配置目录，都改走完整路径。
- Mod 的写操作里，`state`、`prompt`、`observe` 等有时限的操作走已有的本机 HTTP 通道，不用每次启动 `node bridge.cjs mod`。实测中位数：Windows 约 35 毫秒，WSL 约 33 毫秒。几次实测的数值有浮动。
  - **签名协议**：先签名准备，broker 回签名的就绪应答，附一次性票据；然后提交一次；broker 的回应也带签名。签名用 HMAC-SHA256，由 Mod 环境里的 `crypto.subtle.digest` 拼出来。签名密钥只在打开能力时经由进程通道交给 Mod，从不在 HTTP 上传输。非 ASCII 文字先转义再签名。
  - **何时改走进程通道**：准备阶段或进入执行之前的任何失败（拒绝、端口不通、签名不对、体积超限）都安全地改走进程通道。进入执行以后断开或超时，按“结果不确定”处理，不重放。broker 端的写操作上限是 9 秒。
  - **代理**：Mod 的 `$.http.fetch` 发到 127.0.0.1 的请求也会走 `HTTP(S)_PROXY`，而且默认 30 秒超时、不能修改。设置了代理、又没有在 `NO_PROXY` 里排除本机时，本机 HTTP 的读写都关闭，改走进程通道。
  - **发消息**仍走进程通道，时限 135 秒。原因是消息提交以后，broker 还有窗口同步、投递检查和唤醒等后续工作，没法保证在 30 秒内完成。
  - **剩余风险**：broker 恰好在就绪和提交之间退出，同时另一个本机用户抢占了那个端口时，那一条正文可能被对方看到。对方无法伪造结果，也无法改动上下文。Windows 上 Mod 不能使用命名管道，所以保留这一项。

## 运行边界

**Codex 集成**

- Codex 的搭档、任务分工、调度与子代理提醒通过 MCP 工具命名空间说明提供，子代理委派规则在 `partner` 技能里，不在创建线程或逐条消息时重复注入。正常直出配置下，每个新上下文窗口保留一份；严格第三方工具策略可能隐藏这份说明，不绕过该策略。已有线程不追补：工具说明更新产生的历史副本会在原生压缩后归并，新规则随新建线程或重新加载 MCP 后生效。
- 原版 embedded 窗口没有外部 App Server 端点，不能在运行中凭空挂接。
- 接入自有后台的 remote 窗口受官方 remote 限制：模型没有本地任务工具，`/cd`、`/worktree`、Windows 沙箱设置入口、图片编辑和恢复时权限覆盖等与原生窗口不同；命令、MCP 和认证环境来自后台启动时，版本也可能早于当前 CLI。已知版本不一致时提示，不为升级中断正在运行的会话。普通包装窗口默认走官方原生入口，不受这些 remote 限制。
- Codex 外部消息不保证有原生收件气泡；`watch` 提供只读消息和投递观察。
- Codex 共用 daemon 下，只有用户亲手选定、窗口开着且空闲的线程会被有限唤醒，其余空闲线程不会被主动唤醒；`/new` 后需要重新配对；需要窗口连续性和主动唤醒时用 `codex --no-daemon`。

**平台与进程**

- 原生 Windows 与 WSL 不能跨运行环境直接组成同一个本地 pair。
- Windows 独立后台进程以挂起状态、脱离启动方 Job 的方式创建；核验它不在任何 Job 中（否则结束它并提示运行 `nxbridge bootstrap`）后，立即加入 nxbridge 的保护 Job（关闭即终止、允许脱离）。归属登记完成前启动助手若被终止，系统自动结束这个挂起的子进程；登记、恢复运行后才解除终止保护，保护 Job 不限制后台进程及其后续启动。创建到加入保护 Job 之间是助手内紧挨着的两步、没有任何等待，但不是内核级原子操作：助手恰好在这一瞬间被强制结束，理论上仍可能留下挂起进程。
- Linux / macOS 的后台进程直接运行，没有挂起孤儿问题，但启动助手恰好在进程启动后、写入归属记录前被强制结束时，仍可能留下一个未登记的后台进程。
- Linux / macOS 上，Node 只能按进程号发送信号。nxbridge 在发信号前一刻再次核对进程代次，但核对和发信号之间仍有极短的窗口：如果目标恰好在这段时间退出、进程号又被系统分给别的进程，信号可能落到那个进程上。Windows 通过同一个进程句柄核验并结束进程，没有这个窗口。
- Node 24 的内置 SQLite 仍可能输出实验特性提示，协议输出写 stdout，诊断写 stderr。

**Claude 与审批**

- 有的 wrapper 会删掉调用方传给 Claude 的 `--settings`，换成它自己的策略文件和模型地址。通过这类 wrapper 启动的 Claude，不能用 `--settings` 改它的模型地址或其他设置。
- peer 消息不能替另一端执行审批；hold、refuse、用户中断均保留。

## 验收范围

- WSL（Ubuntu-22.04）已完成整套验收。
- 真实模型的长期协作效果，普通用户账户或全新 Windows 机器上的安装，以及 macOS，仍未验收，不能由模拟结果替代。
- macOS 的代码已做静态审查（进程识别用 `ps`、socket 路径长度、Homebrew 安装位置），在 Mac 真机上只验证过下面列出的两处；preflight 和 doctor 会标明 macOS 未验收。
- macOS 的 `ps` 会把不在最后一列的 `comm` 截成 16 个字符，所以所有 `ps` 快照都把 `comm` 放在最后一列，并用实际输出做回归测试，但仍没有 Mac 实机端到端验收。
- 下面两处已在 Mac 真机上验证通过：走共用 daemon 的会话转到后台时选对 Codex 程序，以及 daemon 用户窗口空闲时被叫醒。安装包里的 `tools/collect-macos-evidence.mjs` 直接在安装包里运行，不依赖源码构建。
- 下面几处在 Mac 上只做了模拟测试，没有实机验收（验证步骤见 `tools/macos-validation.md` 第 4 到 6 节）：
  - Codex 把 socket 换成链接时，回收自己启动的后台和 `restart codex`；
  - 手改配置文件后不用 `reload` 即生效；
  - 重新打开窗口后自动送入等待中的消息；
  - 采集器不把进程运行状态的变化当成身份变化，终端证明不要求 `--session`；
  - 新建后台搭档默认用同一配置目录里较新的 Codex。

## 卸载

```sh
nxbridge uninstall --dry-run
nxbridge uninstall
nxbridge uninstall --purge
```

- `--dry-run` 只列出将要做的事，不写配置、不删文件、不停进程。
- 默认卸载保留 nxbridge 的配置、配对账本和消息记录，方便以后重新安装。
- `--purge` 会在确认后台进程都已停止后，再删除 nxbridge 私有目录；两家 CLI 的原生会话历史始终不动。

### 卸载步骤

卸载逐步执行，每一步都单独记录：某一步失败不会挡住其他步骤，失败的部分会列出来，处理后重新执行 `uninstall` 即可接着清理。

1. 通过官方插件命令移除 nxbridge，并恢复仍保持安装时内容的专属配置项，回收登记的 shell 包装。已被用户修改的设置或包装区块保留并报告。
2. 停用自动拉起，归档当前配对。
3. 停止仍归 nxbridge 管理的后台会话和协调器；闲置托管 App Server 通过进程代次核验后回收，仍有已加载线程的运行时保留并报告。

只删除能确认属于 nxbridge 的插件缓存、`nxbridge` 命令和 shell wrapper，别人的同名文件不碰。两家会话历史保留。

### 进程归属

nxbridge 只停止能核验由自己启动的后台进程（核对进程号和代次）；你自己打开的窗口、交给你接管过的会话，以及无法证明归 nxbridge 的进程，一律不停止。

**归属记录**

启动时，归属记录写进 `~/.nxbridge` 里的账本，并在 `~/.nxbridge` 之外另存一份最小副本：

- Windows：`%LOCALAPPDATA%\nxbridge\processes`
- Linux / macOS：`$XDG_STATE_HOME/nxbridge/processes`（未设置时为 `~/.local/state/nxbridge/processes`）

这样即使 `~/.nxbridge` 被删除或账本损坏，卸载仍能找到并停止 nxbridge 自己启动的进程。

- 进程确认退出后，对应记录随之删除；`--purge` 会删除空的副本目录。
- 仍无法确认的记录会保留，卸载输出列出进程号、代次和记录位置，从 Claude、Codex 之外的终端重新执行 `uninstall` 即可继续。
- `doctor` 会列出尚未确认结果的后台启动和无法证明归属的进程，并给出原因和建议操作。

**“某个进程由谁启动”的核验**

- Windows 用 nxbridge 自带的原生身份助手逐级读取进程句柄（进程号、父进程、创建时间、程序路径取自同一句柄），只在助手不可用时逐个按进程号回退到 Win32_Process 查询，不一次取出全部进程，且两者共用同一个时限。
- Linux / macOS 读取 `ps`（Linux 的单个进程身份读 `/proc`）。
- 上级进程已退出或进程号已被复用，算作链条确实到头。
- 无权读取、中途变化或超出层数，算作“无法确认”，此时不据此停止任何进程，除非目标进程比已核验的最早一级上级更晚启动、不可能是更上层的进程。

**短命令的归属**

nxbridge 自己调用宿主 CLI 执行的短命令（查版本、`codex queue` 投递、`claude agents` / `stop` 等，以及修改 Codex 配置时临时启动的 App Server），从创建那一刻起就归 nxbridge 管理，不事后到系统里找进程：

- Windows：原生身份助手以挂起状态创建命令，创建时就原子加入一个专属 Job，然后才放行，命令派生的所有后代都自动在这个 Job 里。Job 设为“最后一个句柄关闭即结束”：超时、输出超限、助手被结束，或者调用它的 nxbridge 进程退出，整棵进程树都会一起结束。
- Linux / macOS：命令在自己的会话和进程组里启动，由一个守护进程看管。守护进程和 nxbridge 之间有一条只有双方持有的管道，nxbridge 崩溃时管道断开，守护进程随即结束整个进程组。
- 账本里只登记直接创建的助手或守护进程，不为了找到真正的宿主进程去枚举系统进程。
- 命令正常结束后，容器里如果还有进程，最多再等 2 秒让它们自己退出（容器已空时不等）。例如 Codex 的 App Server 退出后，它发起的只读 `git ls-remote` 通常在这段时间内结束。超时、助手被结束或 nxbridge 退出时不等，立即结束。2 秒后仍存活的进程，会先把程序名和数量写进 `~/.nxbridge/run/control-survivors.log`，再结束它们；`doctor` 的 `controlProcesses` 显示保留日志中的回收次数和最近 10 条。宿主新版本如果开始在这类命令里顺带拉起常驻进程，这里会先看出来。控制台程序自带的 `conhost.exe` 不计入。
- 带 `--bg` 的命令本来就要脱离启动方长期运行，不放进容器。后台搭档仍由独立启动器启动（见“平台与进程”）：直接启动的就是宿主时不查找后代；经由包装命令启动时，Windows 用原生助手的进程快照，Linux 只沿子进程查，macOS 只查同一进程组，都不用 WMI。
- 宿主命令本身不存在、无权执行或系统资源暂时不足，报成命令失败，资源不足仍会自动重试一次。只有建立容器这一步失败才报 `host_ownership_unknown`，并且会等实际命令结束后再报，不会重放已经执行过的操作。
- Windows 的原生身份助手在安装和更新时就编译好，新运行时在切换前先编译自己的版本，平时的命令只启动已编好的程序。`doctor` 的 `windowsHelper` 显示助手版本、位置和是否已准备；没准备好时运行其中给出的 `nxbridge update`。
- 代价：Windows 上每条短命令多启动一次助手，实测多 0.1～0.3 秒。
