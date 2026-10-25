# 06: Direct-run: `/subagents run <name> <task>` with result-destination option

**What to build:** Users run any defined subagent themselves via `/subagents run <name> <task>`, without going through the main agent and reusing the exact execution path of the `task` tool. By default the result is presented to the user only and kept out of the model's context. A run option lets the user choose to send the result into the model's context instead, where the main agent can build on it.

**Blocked by:** 03

**Status:** ready-for-agent

- [x] `/subagents run <name> <task>` executes the subagent and presents the result to the user
- [x] By default the result does not enter the model's context
- [x] With the result-destination option set (`--to-context`), the result enters the model's context and the main agent can continue from it
- [x] The run shares the `task` tool's execution path: same isolation contract and same definition rules (including 05's enforcement)
