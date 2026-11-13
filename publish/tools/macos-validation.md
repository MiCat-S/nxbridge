# macOS 原生验证

nxbridge 在 Windows 和 WSL 上做过原生验证；macOS 靠 Mac 用户的真机反馈逐步补证据。下面的步骤用来补这些证据，结果请连同输出一起反馈。Windows / WSL 通过不能当作 Mac 也通过。

已在真机上通过（2026-11-12，macOS 27.0，Apple Silicon，Codex 0.167.1 / 0.167.2）：

- 第 4 节：走共用 daemon 的会话转到后台时，用这个会话自己的程序，不拿 ChatGPT 应用自带的旧版；daemon 自动升级后跟着用新版。固定一个更旧的程序时会停下，列出检查过的程序和版本，也不再定时重试。
- 第 5 节：你亲手选的窗口空闲时会被直接叫醒，daemon 自动升级、终端重连后也一样；窗口关掉、`/new` 后、`--no-daemon` 窗口都不会被唤醒；`nxbridge pickup` 能取件。

这一版按真机反馈又修了下面几处，都只做了模拟测试，没有在 Mac 上跑过，特别需要验证：

- **回收 nxbridge 自己启动的后台 Codex。** Codex 会把 nxbridge 指定的 socket 换成一个链接，旧版因此一律拒绝回收，`nxbridge restart codex` 也会被拒。见第 6 节。
- **直接编辑配置文件即可生效。** 改了 `~/.nxbridge/config.toml` 不用再运行 `nxbridge reload`，协调进程会自己重新读取。见第 4 节第 4 步。
- **重新打开窗口后自动收信。** 窗口关掉期间收到的消息，用 `codex resume <会话ID>` 重新打开后，等窗口空闲就会直接送入，不用再输入 `nxbridge pickup`。见第 5 节。
- **采集器的两处修正。** 终端证明不再要求 `--session`；进程运行状态变化（`ps` 的状态列从 `Ss` 变成 `Rs` 之类）不再被当成身份变化。

没有 Mac 实测证据的其他部分保持保守行为：证明不了就只取件、不唤醒；共用 daemon 不当作 nxbridge 自有后台去停止。

所有步骤都在隔离环境里做：只用这次新建的临时 home 和本地免费模型夹具，不读写正式配置和消息数据库，只处理这次启动、身份已确认的进程。监督器给每个测试会话设了三分钟上限。不要为了测试去结束你正在用的会话。

## 采集器在哪里运行

`tools/collect-macos-evidence.mjs` 是只读采集器，直接在安装包目录（或 `~/.nxbridge/runtime`）里运行，不需要源码，也不需要 `npm run build`：

```sh
node tools/collect-macos-evidence.mjs --pid <PID> [--home <配置目录>] [--socket <socket 路径>] [--session <会话ID>] [--endpoint unix://<socket>|ws://<地址>]
```

`--home`、`--socket` 和 `unix://` 后面的路径可以用 `~/` 开头。终端证明只需要 `--endpoint`；查询线程是否被占用（`sessionHold`）才需要 `--session`。只有 `--validate-transfer`（第 1 节）和第 2 节的隔离测试需要源码仓库，在源码目录先 `npm run build` 再运行。

## 1. 会话转移

在源码目录运行：

```sh
npm run build
node tools/collect-macos-evidence.mjs --validate-transfer
```

自动验证：

- `release` 后原后台进程确实退出，之后用 remote 方式打开时能发现原线程；
- 对还开着的窗口执行 `adopt` 只记下意愿，窗口关掉、线程卸载后才转到后台，会话 ID、配对、历史和完整权限都不变。

看不到线程的其他私有 App Server（例如 ChatGPT 应用自带的）会挡住接管，并显示是哪个进程。

### ChatGPT 应用占着会话时

Mac 上 ChatGPT 应用开着时，它自己的 App Server 一直在运行，nxbridge 无法确认它有没有加载你的会话，所以 `nxbridge adopt codex` 会提示被占用。解开的方法：

1. 在 ChatGPT 应用里关掉这个会话；仍提示被占用时，退出 ChatGPT 应用（菜单栏 ChatGPT → 退出，或 ⌘Q）。
2. 重新运行 `nxbridge adopt codex`（或在 Claude 里再发一次消息，按选择框处理）。

请帮忙测一下应用的服务什么时候真正放开会话，结果决定以后能否放宽这条限制。找到应用 App Server 的 PID（`pgrep -fl "codex app-server"`）和测试会话 ID，在下面三个时间点各运行一次：

```sh
node tools/collect-macos-evidence.mjs --pid <应用 App Server 的 PID> --session <会话ID> [--endpoint unix:///实际/socket 或 ws://地址] [--home <配置目录>]
```

| 时间点 | 记录 |
| --- | --- |
| 在应用里关掉会话后立刻 | 输出里的 `sessionHold.state` 和 `checkedAt`，以及进程是否还在 |
| 关掉会话后等 2 分钟 | 同上 |
| 退出 ChatGPT 应用后 | 同上 |

`sessionHold.state` 的含义：

- `loaded` / `not_loaded`：采集器连上了这个服务，只读查询了已加载线程列表（`thread/loaded/list`），这是实测结果。
- `unobservable`：找不到可连接的端点、没有权限或无法读取，输出里会写原因；这时只有进程是否存活的快照。会话历史一直没有新内容、或者应用里已关掉会话，都不能推断它已经放开。

采集器不会尝试抢占会话或探测写锁。

### 手工重入

另开一个测试会话，在 ChatGPT 应用、默认 daemon、`--no-daemon`、`nxbridge codex`（remote）之间来回打开同一会话，确认：

- 关掉原窗口后配对保留，消息暂存；
- `adopt` 接手后会话 ID 不变；
- `release` 确认后台退出后，用其他方式打开能接回原配对；
- 有活动写锁或待审批时显示受阻，要在原窗口处理；不会自动回答，也不会重复提交结果不明的消息。

### 从自行打补丁的版本更新

从手工补丁版本 `9adde6a52f32` 更新时：先运行 `nxbridge status` 保存一份摘要，再用正式的 `nxbridge update --from <解压目录>` 更新；核对原成员、配对、消息和路径都保留。更新后可以删掉 `~/.nxbridge/adopt-codex.json`，新版本完全忽略这个文件，它也不是受支持的托管授权入口。

## 2. 后台连接隔离

在源码目录运行：

```sh
npm run build
node tools/run-tests.mjs --test --test-concurrency=1 --test-timeout=180000 dist/native-tests/isolation-options.test.js
```

只用临时 home，不发起模型请求。比较进程级配置开关、私有 socket 和本地 WebSocket，并验证：

- 无凭证连接被拒绝；
- 同一 home 的共用后台和认证后台不共享已加载线程；
- 停止认证后台不影响共用后台的线程。

结果只用于核验，不会打开任何运行时开关；macOS 在证据通过前继续用现有的私有 socket。

## 3. 只读采集器的输出

采集器只查询进程、文件描述符和路径元数据，结果以 JSON 输出到终端。它不读完整环境变量、提示词、配置正文或消息数据库，不附加控制台，也不启动宿主。`ps` 固定用 `LC_TIME=C`、`LC_CTYPE=UTF-8`、`TZ=UTC` 运行，并移除会覆盖它们的 `LC_ALL`，不受你的语言和时区设置影响。

- 输出里的 home 是你声明的值，不能证明进程实际用的配置目录。
- 从 `ps -E` 读到的配置目录只作为未经核验的线索（输出为 `homeHint`，`verified: false`，不输出原始环境变量）：BSD `ps` 会把参数和环境变量拼在一起，遇到空格或重复的变量名时不可靠。
- 分开拍的秒级快照不能代替对同一进程代次的持续观察。
- 给了 `--endpoint unix://…` 时，输出里还有 `terminalProof`（第 5 节的终端证明，含原因）和 `terminalEvidenceVerified`。证明通过只说明终端证据成立，是否真的唤醒还要看配对时有没有亲手选择、线程是否空闲等条件。

## 4. 转到后台时选用的 Codex 程序

场景：同时装了 Homebrew 的 `codex` 和 ChatGPT 应用（应用自带一份 Codex，版本可能更旧），在终端用 `codex` 打开会话（走共用 daemon），配对后关掉窗口，转到后台。

1. 在终端运行 `codex`，开一个测试会话，和 Claude 配对，来回发一条消息。
2. 运行 `nxbridge status --json`，在 `launches.observations` 里应能看到这个会话的一条记录：`kind` 为 `daemon`，程序是 daemon 的程序，版本和 daemon 一致，`variableCount` 为 0（不记环境变量）。
3. 关掉 Codex 窗口，等 daemon 放开这个会话（通常一两分钟），再运行 `nxbridge adopt codex`。这个命令要在交互式终端里运行；不方便时，也可以在 Claude 发信后出现的选择里选“后台继续原会话”。应当直接转到后台，`hosting.verified` 为 `true`；后台进程用的是 daemon 的程序或 Homebrew 的入口，不是 ChatGPT 应用里的那份。
4. 反向检查：把 `hosts.codex.binary` 固定为一个更旧的 Codex，再重复第 1 到第 3 步。固定的方法有两种：
   - 在系统终端运行 `nxbridge config set hosts.codex.binary <路径>`。这个命令要求交互式终端，是有意的设计。
   - 远程连接、不方便用终端时，直接编辑 `~/.nxbridge/config.toml`。

   应当停下，状态里列出检查过的程序和版本，并提示取消固定（`nxbridge config unset hosts.codex.binary`）；消息保留，之后不再每隔几分钟重试。

   然后取消固定，用命令或删掉文件里那一行都行：不用 `nxbridge reload`，约 30 秒内自动重新核验并转到后台。两种改法请都试一次。

请反馈每一步的 `nxbridge status --json` 里 `hosting` 和 `launches` 两段（可以去掉路径里的用户名）。

## 5. 直接唤醒的终端证明

和 Linux 一样，只有你在选择框里亲手选了这个窗口（或用了配对码）、线程空闲、并且能证明这个配置目录有一个活着的终端连在共用 daemon 上时，才会直接把消息送进去。macOS 上的证明这样做，全部只读：

1. 用 `ps` 列出 `codex` 进程，只留交互式 TUI：排除 `--no-daemon`、显式 `--remote`、`exec` / `review` / `login` / `mcp` / `app-server` 等子命令；直接带提示词启动的 `codex <提示词>` 算 TUI。
2. 只对这些候选进程和 daemon 进程运行 `lsof`：候选的标准输入输出必须是终端；它要有一个 unix socket，对端正是 daemon 进程在这个配置目录的控制 socket（`~/.codex/app-server-control/app-server-control.sock` 指向的路径）上的监听连接。
3. 核验前后再取一次两个进程的 `lstart`，启动代次不变才算数。

证明的粒度和 Linux 一样：证明的是“这个配置目录有一个活着的终端连在 daemon 上”，不是“这个窗口此刻正显示这个会话”。在同一窗口 `/new`、在同一项目里另开 Codex 对话时，照样先停止唤醒，等你重新选择。

证明不了时消息只存不送：状态栏会写明，在那个 Codex 窗口里输入 `nxbridge pickup`（或 `nxbridge 收信`）就能取件。Codex 会同时收到说明：这句话只是取件，不是在回答问题或批准操作。

请在真机上验证并反馈：

| 场景 | 应当 |
| --- | --- |
| 亲手选的窗口空闲，Claude 发来消息 | 窗口里自动开始处理，无需输入 |
| 关掉这个窗口后发消息 | 不唤醒；提示窗口已关，重新打开会话后取件 |
| 窗口关掉期间收到消息，再用 `codex resume <会话ID>` 重新打开 | 窗口空闲后直接送入，不用输入 `nxbridge pickup`（这一版新修，需要验证） |
| 同一窗口 `/new`，或同项目另开一个 Codex 对话 | 停止唤醒，提示重新配对 |
| `codex --no-daemon` 或 `codex --remote …` 打开的窗口 | 不算共用 daemon 的终端 |
| 合上屏幕休眠再唤醒 | 重新取证；拿不到证据时只取件 |
| 输入 `nxbridge pickup` | 取到等待中的消息，Codex 不把它当成回答 |

每个场景请附上一次采集器输出，重点是 `terminalProof`。终端证明以 daemon 为起点，所以 `--pid` 填 daemon 进程的 PID（`pgrep -fl -- '--managed-daemon'`；`app-server` 和 `--managed-daemon` 之间还有别的参数），`--endpoint` 填 `unix://~/.codex/app-server-control/app-server-control.sock`，`--home` 填配置目录；想同时看会话状态再加 `--session <会话ID>`。

## 6. 回收 nxbridge 自己启动的后台 Codex

nxbridge 让后台 Codex 在 `~/.nxbridge/run/cx-*.sock` 上监听。Codex 会把这个路径换成一个链接，指向 `/tmp/codex-daemon-<uid>/` 下按原路径算出的 socket，所有 Unix 系统上都这样做。旧版只要看到链接就当作“别人的后台”，所以解除配对后回收不了，`nxbridge restart codex` 也会被拒。

新版要核验三件事，才把它当作 nxbridge 自己的后台：
- 链接确实是 Codex 按这个路径生成的；
- 目标 socket 归你所有，并且正由记录的那个进程监听；
- 核验前后进程代次不变。

`/tmp/codex-daemon-<uid>/` 下的 socket 和同名 `.lock` 由 Codex 自己在正常退出时清理，nxbridge 证明不了安全时不会去删。

请在真机上验证：

1. 更新后运行 `nxbridge doctor`，看 `retirements`：
   - 旧版留下、进程还在的条目，运行 `nxbridge retire --member <ID>`。应当返回 `"released": true`，进程退出，`~/.nxbridge/run/` 里对应的链接被删掉。
   - 进程早已不在的条目，应当按当前情况显示“进程已退出”，或“没有已登记的可核验进程，仅剩未结算记录”，不再显示旧的“无法核验独占原生后台”（旧原因单独列为上次失败）。
2. 新配一个后台 Codex 搭档，来回一条消息后解除配对。后台进程应当自动退出，链接被删掉，也不出现在 `retirements` 里。
3. 一个正在用的后台 Codex 搭档空闲时，在系统终端运行 `nxbridge restart codex`。应当重启成功，会话 ID 不变。
4. `~/.nxbridge/run/` 里早已失效的链接（目标已不存在的 `cx-*.sock`）应当被清理。
5. 后台 Claude 成员如果从没真正启动，应当显示“没有已登记的可核验进程，仅剩未结算记录”，并且立即停止自动重试，不再每分钟重试一次。

被拒时，`nxbridge retire` 的输出会列出核验过程：`requested`（请求的路径）、`resolved`（实际目标）、`expectedTarget`（按 Codex 规则算出的目标）、`expectedPid` / `expectedGeneration`（记录的进程和代次）、`observedGeneration`（实际代次）和 `listenerVerified`（是否核验到这个进程在监听）。被拒请把这段一起反馈。

请反馈：
- 每一步的输出；
- `nxbridge doctor` 里 `managedRuntimes` 和 `retirements` 两段；
- `ls -la ~/.nxbridge/run/` 的结果。

路径里的用户名可以去掉。
