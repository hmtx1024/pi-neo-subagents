# 03: `task` tool MVP: isolated delegation + result return + dynamic enumeration

**What to build:** The main agent discovers delegation targets through a model-callable `task` tool whose description dynamically enumerates every available agent (name + description) with delegation guidance, and refreshes when definition files change mid-session. Calling `task` with an agent name and a self-contained task description runs the task as a nested, fully isolated agent session: its own conversation history, Pi's default system prompt with the definition body appended as specialization instructions, all default tools except `task` itself (no recursion), inheriting the host session's current model. The subagent receives only the task text — no host history crosses the boundary. Its final reply comes back as the tool result content. Delegations are serial and one level deep; the nested session is cancelled through the tool's abort signal and disposed after every run.

**Blocked by:** 02

**Status:** ready-for-agent

- [x] The `task` tool description dynamically enumerates all discovered agents (name + description) plus delegation guidance
- [x] The enumeration refreshes when agent definition files are added, changed, or removed mid-session
- [x] A delegation runs in a nested isolated session that receives only the task text and no host conversation history
- [x] The subagent's system prompt is Pi's default prompt with the definition body appended
- [x] The subagent's tool set is all default tools minus `task`; delegation cannot recurse
- [x] The subagent inherits the host session's current model when the definition pins none
- [x] The subagent's final reply is returned as the `task` tool result content
- [x] Cancelling through the tool's abort signal stops the nested session
- [x] Nested sessions are disposed after each task; reload and session switches leave no leaked state
