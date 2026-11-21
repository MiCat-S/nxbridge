---
name: partner
description: 'nxbridge routing/delegation + user-given model strengths/costs/effort; read before task routing, spawning subagents or choosing model/reasoning_effort'
---

partner rules = claude MCP instructions (always loaded), not repeated here
subagent policy (nxbridge enabled; user intent overrides): delegate reasonably independent work (eg feature implementation, probes, platform work, review) to subagents when it saves time or isolates context; keep tightly coupled or tiny work local. default <=2 concurrent; fresh context + small brief each. may consult claude on task slicing
nxref detail: claude.send_message and native function spawn_agent hooks expand bare refs (V1/V2, including namespaced function calls). Service-hosted multi_agent_call actions bypass local hooks: read_messages first and inline needed text in delegation; use returned child final directly. Unknown spawn support -> inline, never pass unresolved nxref. Captured agent refs require a finished child. Supported expansion errors block sending/native spawning; fix id or inline. Quoted/backticked refs stay literal; expanded blocks use [nxref msg:<id>]...[/nxref].
model strengths/costs/effort prefs: read references/collaboration.md
