# nxbridge collaboration guide

This guide describes how Claude and Codex work together through nxbridge, and what each model is good at. The model notes are the user's own assessment, given on 2026-10-31. Where an individual note and the final rankings disagree, the final rankings win.

## Messaging

Claude and Codex are equal partners and coworkers. Neither is the other's subagent. Talk to each other often.

| You are | How to reach your partner |
|---|---|
| Codex | `claude.send_message` sends a message, `claude.status` shows the partner's state, `claude.receive_messages` picks up incoming messages. |
| Claude | Native `ListAgents` shows the partner and `SendMessage` to `nxbridge:codex` sends a message. If the nxbridge mod is not loaded, use the `codex` MCP tools provided by the plugin instead. |

## GPT models

**GPT-6.1 Sol** is the main GPT model. On mainstream tech stacks it is about as capable as GPT-6 Astra, but costs 60% less. Use it for normal development; it handles medium to high difficulty work.

**GPT-6 Astra** is the strongest backend model. It is a large model with broad world knowledge. It is good at every hard backend problem, at architecture design, at graphics modeling, and at locating and fixing difficult bugs.

**GPT-6.1 Terra** is the cost-effective option. It is rigid, even compared with Sol and Astra, which are already somewhat rigid. It costs 30% less than Sol. It fits backend tasks with a clear goal, or of low to medium difficulty.

Weaknesses shared by all GPT models:
- Poor at expressing themselves.
- Low initiative. They do everything the task states, and do it well, but do little that the task leaves unstated.
- Tend toward over-engineering and over-caution. During solution design this is partly an advantage.
- Except for Astra, only average at architecture design.

Strengths shared by all GPT models:
- Strong raw intelligence.
- Thorough and careful thinking.
- Efficient, with good results, when the goal is clear.

Give all backend work to GPT models. For Sol and Astra use effort high or xhigh, and max when needed. For Terra use xhigh; max makes it stronger but costs much more time and money.

## Claude models

**Opus 5.5** is the main Claude model. In almost every ability it is equal to or better than Fable 5.1, and it costs 70% less. Its strengths: it talks like a person, has good taste and strong intuition, and takes initiative.

**Fable 5.1** is an older model. It is strong at frontend work and ergonomics; in everything else it is below Opus 5.5. Use it as a second opinion for product design, architecture design, interaction design and frontend work.

All Claude models are good at architecture design, orchestrating multiple models and planning tasks. They are strong at frontend work, weaker at backend work, and expensive.

For Claude models use effort high or xhigh by default. Max is rarely needed.

## Final rankings

These rankings were given last and take precedence over everything above.

| Area | Ranking |
|---|---|
| Frontend | Opus 5.5 ≥ Fable 5.1 (Fable is ahead on the big picture) ≫ GPT |
| Backend | Astra ≥ Sol > Terra > Claude |
| Macro design | Opus, Fable and Astra each have strengths and weaknesses; discuss it together |
| Security | GPT ≫ others |
| Graphics modeling | Astra is strongest |
| Computer use | GPT |
| Aesthetics | Claude |

Graphics modeling: Sol may fall short -> consider Astra first.
| Writing, comprehension, initiative and other intuition-related work | Opus ≥ Fable ≫ GPT |
