# nxbridge Claude 插件

本插件让 Claude Code 与 Codex CLI 作为平等搭档交换消息。它保留 Claude 的原生会话、工具、审批和 peer inbox，通过 Mod 向 ListAgents 增加搭档，并仅接管发送到 nxbridge:codex 的 SendMessage 调用。

Mod 还按宿主记录的当前 turn 来源路由 AskUserQuestion：Codex 发起的任务先问 Codex，回答后返回原生答案与搭档来源说明；需要用户、超时或取消时回原生表单。用户与未知来源保持原生，不改变权限对话框。Codex 的显式提问由注册的 answer_question 作答，action:ask_user 可受控弹原生问题。挂起期间不反问，等待状态与截止时间可在 nxbridge 查看。

先在 nxbridge 工程运行 `npm install`、`npm run build` 和 `node dist/cli.js setup`。现有 Claude 窗口使用 `/reload-plugins` 加载插件，`/nxbridge` 查询状态。

插件不会转交 child token，不会伪造会话登记，不会替用户批准另一端的动作。消息已提交不表示对方已读；入站 hold 与 refuse 保留。原生 Mod 不可用时，同包 MCP 提供独立工具入口。

收到含至少两处不同文件、目录或行范围的消息时，正文后附一次并行查阅和编码提醒；正文和账本不变。模型提示与技能为精简英文。

`partner` 技能提供通信入口、多交流的提醒与模型特点。模型文档的唯一维护来源是工程的 `docs/collaboration.md`；安装时复制为 `skills/partner/references/collaboration.md`，与技能一同交付。
