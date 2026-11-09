# macOS 原生验证

nxbridge 在 Windows 和 WSL 上做过原生验证，macOS 还没有。下面的步骤用来补上 Mac 的证据，结果请连同输出一起反馈。Windows / WSL 通过不能当作 Mac 也通过；没有 Mac 实测证据的功能保持保守行为：用户终端不主动唤醒，共用 daemon 不当作 nxbridge 自有后台去停止。

所有步骤都在隔离环境里做：只用这次新建的临时 home 和本地免费模型夹具，不读写正式配置和消息数据库，只处理这次启动、身份已确认的进程。监督器给每个测试会话设了三分钟上限。不要为了测试去结束你正在用的会话。

## 1. 会话转移

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

请帮忙测一下应用的服务什么时候真正放开会话，结果决定以后能否放宽这条限制。找到应用 App Server 的 PID（`pgrep -fl "codex app-server"`）和测试会话 ID，先运行过 `npm run build`，再在下面三个时间点各运行一次：

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

```sh
npm run build
node tools/run-tests.mjs --test --test-concurrency=1 --test-timeout=180000 dist/native-tests/isolation-options.test.js
```

只用临时 home，不发起模型请求。比较进程级配置开关、私有 socket 和本地 WebSocket，并验证：

- 无凭证连接被拒绝；
- 同一 home 的共用后台和认证后台不共享已加载线程；
- 停止认证后台不影响共用后台的线程。

结果只用于核验，不会打开任何运行时开关；macOS 在证据通过前继续用现有的私有 socket。

## 3. 只读采集器

先在要观察的终端找到原生 Codex 的 PID，再运行：

```sh
node tools/collect-macos-evidence.mjs --pid 12345 --home "$CODEX_HOME" --socket /实际/socket/路径
```

采集器只查询进程、文件描述符和路径元数据，结果以 JSON 输出到终端。它不读完整环境变量、提示词、配置正文或消息数据库，不附加控制台，也不启动宿主。

- 输出里的 home 是你声明的值，不能证明进程实际用的配置目录。
- 从 `ps -E` 读到的配置目录只作为未经核验的线索（输出为 `homeHint`，`verified: false`，不输出原始环境变量）：BSD `ps` 会把参数和环境变量拼在一起，遇到空格或重复的变量名时不可靠。
- 分开拍的秒级快照不能代替对同一进程代次的持续观察。

## 4. 待验证场景

在独立临时目录里逐项验证：

| 场景 | 必须满足 |
| --- | --- |
| 原生稳定版与 0.166 alpha | 分别记录版本、入口和全局 `--no-daemon` 能力；参数被接受不等于实际隔离 |
| 默认共用 daemon 与专用 App Server 并存 | 私有 socket 不是共用端点的别名；停止这次的专用进程后，用户 daemon 和终端仍在 |
| 专用后台断连、正常退出、异常退出 | 同一会话恢复时保留原 home、入口和配对；已接收的消息保留，结果不明的不重投 |
| 用户临时接手后关掉窗口 | 租约交还后台；启动失败或结果不明时先核对进程，不重复拉起 |
| 两个项目、同项目两组配对、子代理 | 只处理原配对和原会话；根会话与子代理不混淆 |
| 同一会话另开一个终端 | 暂停后台投递并让用户选择，不抢线程 |
| 自动更新与旧版本目录删除 | 只跟随同一安装渠道的稳定入口；其他安装和应用内二进制不能顶替 |
| 休眠唤醒、短暂权限失败、socket 符号链接 | 重新取证；结果未知不等于进程已死，不能据此清理或连续重试 |

## 5. 直接唤醒的证据门槛

和 Linux 一样，要同时证明：同一个存活的原生进程代次、TUI 启动参数、实际 CODEX_HOME、标准输入输出都是终端。macOS 上可以研究 `KERN_PROCARGS2` 的 NUL 分段，以及 libproc 的进程代次和 fd 设备查询；`ps eww`、cwd、TTY 列单独都不够。Windows 上的 console-host PID 也不能单独证明标准输入输出没被重定向。这些证明拿到之前，继续只取件、不唤醒。
