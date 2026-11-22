# macOS 原生验证

nxbridge 在 Windows 和 WSL 上做过原生验证，macOS 只在真机上验证过一部分。下面的步骤可以在你自己的 Mac 上确认这些功能是否正常。Windows / WSL 通过不能当作 Mac 也通过。

已在真机上通过（macOS 27.0，Apple Silicon，Codex 0.167.1 / 0.167.2）：

- 第 4 节：走共用 daemon 的会话转到后台时，用这个会话自己的程序，不拿 ChatGPT 应用自带的、版本更旧的 Codex；daemon 自动升级后跟着用升级后的程序。固定一个更旧的程序时会停下，列出检查过的程序和版本，也不会定时重试。

下面几处只做了模拟测试，没有在 Mac 上跑过，特别需要验证：

- **回收 nxbridge 自己启动的后台 Codex。** Codex 会把 nxbridge 指定的 socket 换成一个链接，nxbridge 核验链接确实指向自己的后台后才会回收，`nxbridge restart codex` 也一样。见第 6 节。
- **直接编辑配置文件即可生效。** 改了 `~/.nxbridge/config.toml` 不用运行 `nxbridge reload`，协调进程会自己重新读取。见第 4 节第 4 步。
- **重新打开窗口后自动收信。** 窗口关掉期间收到的消息，用 `codex resume <会话ID>` 重新打开后，等窗口空闲就会直接送入，不用输入 `nxbridge pickup`。见第 5 节。
- **直接唤醒按原生线程核验。** 读取明确选中会话的已加载、空闲状态，并在提交前复核授权和窗口绑定；退出宽限期内出现的原生审批仍由用户处理。见第 5 节。
- **采集器的身份比较。** 进程运行状态变化（`ps` 的状态列从 `Ss` 变成 `Rs` 之类）不会被当成身份变化；报告保留进程快照和指定端点的线程占用情况。

没有 Mac 实测证据的其他部分保持保守行为：证明不了就只取件、不唤醒；共用 daemon 不当作 nxbridge 自有后台去停止。

所有步骤都在隔离环境里做：只用这次新建的临时 home 和本地免费模型夹具，不读写正式配置和消息数据库，只处理这次启动、身份已确认的进程。监督器给每个测试会话设了三分钟上限。不要为了测试去结束你正在用的会话。

## 采集器在哪里运行

`tools/collect-macos-evidence.mjs` 是只读采集器，直接在安装包目录（或 `~/.nxbridge/runtime`）里运行，不需要源码，也不需要 `npm run build`：

```sh
node tools/collect-macos-evidence.mjs --pid <PID> [--home <配置目录>] [--socket <socket 路径>] [--session <会话ID>] [--endpoint unix://<socket>|ws://<地址>]
```

`--home`、`--socket` 和 `unix://` 后面的路径可以用 `~/` 开头。查询线程是否被占用（`sessionHold`）需要同时提供 `--session` 和可连接的 `--endpoint`。只有 `--validate-transfer`（第 1 节）和第 2 节的隔离测试需要源码仓库，在源码目录先 `npm run build` 再运行。

`sessionHold.state` 的含义：

- `loaded` / `not_loaded`：采集器连上了这个服务，只读查询了已加载线程列表（`thread/loaded/list`），这是实测结果。
- `unobservable`：找不到可连接的端点、没有权限或无法读取，输出里会写原因；这时只有进程是否存活的快照。会话历史一直没有新内容、或者应用里已关掉会话，都不能推断它已经放开。

采集器不会尝试抢占会话或探测写锁。

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

### 手工重入

另开一个测试会话，在 ChatGPT 应用、默认 daemon、`--no-daemon`、`nxbridge codex`（remote）之间来回打开同一会话，确认：

- 关掉原窗口后配对保留，消息暂存；
- `adopt` 接手后会话 ID 不变；
- `release` 确认后台退出后，用其他方式打开能接回原配对；
- 有活动写锁或待审批时显示受阻，要在原窗口处理；不会自动回答，也不会重复提交结果不明的消息。

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
- 给了 `--session` 和 `--endpoint` 时，`sessionHold` 显示这个端点是否加载了指定会话。直接唤醒还要核验原生空闲状态、配对授权和窗口绑定，见第 5 节。

## 4. 转到后台时选用的 Codex 程序

场景：同时装了 Homebrew 的 `codex` 和 ChatGPT 应用（应用自带一份 Codex，版本可能更旧），在终端用 `codex` 打开会话（走共用 daemon），配对后关掉窗口，转到后台。

1. 在终端运行 `codex`，开一个测试会话，和 Claude 配对，来回发一条消息。
2. 运行 `nxbridge status --json`，在 `launches.observations` 里应能看到这个会话的一条记录：`kind` 为 `daemon`，程序是 daemon 的程序，版本和 daemon 一致，`variableCount` 为 0（不记环境变量）。
3. 关掉 Codex 窗口，等 daemon 放开这个会话（通常一两分钟），再运行 `nxbridge adopt codex`。这个命令要在交互式终端里运行；不方便时，也可以在 Claude 发信后出现的选择里选“后台继续原会话”。应当直接转到后台，`hosting.verified` 为 `true`；后台进程用的是 daemon 的程序或 Homebrew 的入口，不是 ChatGPT 应用里的那份。
4. 反向检查：把 `hosts.codex.binary` 固定为一个更旧的 Codex，再重复第 1 到第 3 步。固定的方法有两种：
   - 在系统终端运行 `nxbridge config set hosts.codex.binary <路径>`。这个命令要求交互式终端，是有意的设计。
   - 远程连接、不方便用终端时，直接编辑 `~/.nxbridge/config.toml`。

   应当停下，状态里列出检查过的程序和版本，并提示取消固定（`nxbridge config unset hosts.codex.binary`）；消息保留，之后不会每隔几分钟重试。

   然后取消固定，用命令或删掉文件里那一行都行：不用 `nxbridge reload`，约 30 秒内自动重新核验并转到后台。两种改法请都试一次。

每一步的结果看 `nxbridge status --json` 里的 `hosting` 和 `launches` 两段。

## 5. 直接唤醒的线程状态核验

只有你在选择框里亲手选了这个窗口（或用了配对码）、明确选中的会话仍由共用 daemon 加载且空闲，并且窗口绑定仍有效时，才会直接把消息送进去。各平台使用相同的只读核验：

1. 按已登记的 daemon 路由查找准确的会话 ID，读取该原生线程；查询不订阅或恢复线程。
2. 原生状态必须是 `idle`；正在运行、等待审批、已卸载或无法读取时，消息保留待处理。
3. 提交前再次读取原生线程，并复核配对授权和窗口绑定；暂停、解除配对、关闭 nxbridge 或切换上下文都能阻止提交。

最后一个客户端断开后，daemon 可能在宽限期内继续加载线程。如果这时提交触发原生审批，仍须人工处理，nxbridge 不会自动回答审批。在同一窗口 `/new`、或同项目另开 Codex 对话导致前台上下文变化时，先停止唤醒，等你重新选择。

无法完成核验时，状态栏会说明消息正在等待。在对应 Codex 窗口里输入 `nxbridge pickup`（或 `nxbridge 收信`）可以取件。Codex 会同时收到说明：这句话只是取件，不是在回答问题或批准操作。

可以在真机上这样验证：

| 场景 | 应当 |
| --- | --- |
| 亲手选的窗口空闲，Claude 发来消息 | 窗口里自动开始处理，无需输入 |
| 关掉这个窗口后发消息 | 线程已卸载时保留消息；退出宽限期内按原生线程状态处理，需要审批时等待人工 |
| 窗口关掉期间收到消息，再用 `codex resume <会话ID>` 重新打开 | 窗口空闲后直接送入，不用输入 `nxbridge pickup` |
| 同一窗口 `/new`，或同项目另开一个 Codex 对话 | 停止唤醒，提示重新配对 |
| 合上屏幕休眠再唤醒 | 重新核验线程和授权；无法读取时保留消息 |
| 输入 `nxbridge pickup` | 取到等待中的消息，Codex 不把它当成回答 |

每个场景都可以用 `nxbridge status --json` 和采集器查看结果，重点看 `sessionHold` 和进程身份快照。`--pid` 填 daemon 进程的 PID（`pgrep -fl -- '--managed-daemon'`；`app-server` 和 `--managed-daemon` 之间还有别的参数），`--endpoint` 填 `unix://~/.codex/app-server-control/app-server-control.sock`，`--home` 填配置目录，`--session` 填待收信的会话 ID。

## 6. 回收 nxbridge 自己启动的后台 Codex

nxbridge 让后台 Codex 在 `~/.nxbridge/run/cx-*.sock` 上监听。Codex 会把这个路径换成一个链接，指向 `/tmp/codex-daemon-<uid>/` 下按原路径算出的 socket，所有 Unix 系统上都这样做。

nxbridge 核验三件事，才把它当作自己的后台：
- 链接确实是 Codex 按这个路径生成的；
- 目标 socket 归你所有，并且正由记录的那个进程监听；
- 核验前后进程代次不变。

`/tmp/codex-daemon-<uid>/` 下的 socket 和同名 `.lock` 由 Codex 自己在正常退出时清理，nxbridge 证明不了安全时不会去删。

请在真机上验证：

1. 运行 `nxbridge doctor`，看 `retirements`：
   - 进程还在的条目，运行 `nxbridge retire --member <ID>`。应当返回 `"released": true`，进程退出，`~/.nxbridge/run/` 里对应的链接被删掉。
   - 进程早已不在的条目，应当按当前情况显示“进程已退出”，或“没有已登记的可核验进程，仅剩未结算记录”。
2. 新配一个后台 Codex 搭档，来回一条消息后解除配对。后台进程应当自动退出，链接被删掉，也不出现在 `retirements` 里。
3. 一个正在用的后台 Codex 搭档空闲时，在系统终端运行 `nxbridge restart codex`。应当重启成功，会话 ID 不变。
4. `~/.nxbridge/run/` 里早已失效的链接（目标已不存在的 `cx-*.sock`）应当被清理。
5. 后台 Claude 成员如果从没真正启动，应当显示“没有已登记的可核验进程，仅剩未结算记录”，并且立即停止自动重试。

被拒时，`nxbridge retire` 的输出会列出核验过程：`requested`（请求的路径）、`resolved`（实际目标）、`expectedTarget`（按 Codex 规则算出的目标）、`expectedPid` / `expectedGeneration`（记录的进程和代次）、`observedGeneration`（实际代次）和 `listenerVerified`（是否核验到这个进程在监听）。

## 7. Codex hook 的耗时与三秒时限

Codex hook 的日常路径：

- hook 进程只读输入、确认没被关闭，就把输入和自己的进程号交给协调器，不加载大段代码。
- 进程身份由协调器根据这个仍在运行的 hook 进程去查。Mac 上协调器用 `ps` 查，hook 进程本身不查，也不会调用 `lsof` 或扫描其他后台。
- 协调器没在运行或版本比 hook 旧时，hook 自己走完整流程；请求一旦交给协调器，出错也不会重做。
- 会话结束和中断这两类 hook 按 3 秒上限设计，其他 hook 按 10 秒。快到时限还没处理完就先返回，Codex 里会出现一行 `nxbridge hook timed out after 3s; result unconfirmed`（或 `10s`）警告，nxbridge 的“hook 超时”提醒会把它计入。

Windows 上的测量（中位数 / p95，毫秒；从直接启动 Node 算起，不含 Codex 启动 hook 时先开的命令行外壳）：

- 机器较空闲：工具调用后 192/248，会话结束 154/239，中断 183/243。
- 机器很忙：工具调用后 602/838，提交输入 630/985。

Mac 上还没实测，不能直接套用这些数字。

请在隔离配置中，用 nxbridge 启动的后台 Codex 搭档验证。只有后台 Codex 能读到 Codex 自己记录的耗时，你自己开的 Codex 窗口不会出现在结果里。

1. 让后台 Codex 正常干一会儿活（至少 20 次工具调用），确认双方照常收到消息提醒；上下文压缩后，恢复信息仍在。
2. 中断它当前的一轮，确认 Claude 一侧看到它暂停。
3. 运行下面的命令查看耗时。每类 hook 会列出次数、最近一次、中位数（`p50Ms`）、p95（`p95Ms`）和最大值，单位毫秒。这是 Codex 自己记录的整次耗时，包含外壳启动，会比上面的数字大：

   ```sh
   nxbridge status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).capabilities.hookTimings,null,2)))'
   ```

4. 在你自己开的 Codex 窗口里退出一次，确认退出时没有明显卡顿。

不要为了测试去改真实配置里的信任记录。
