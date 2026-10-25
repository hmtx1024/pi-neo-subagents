# 05: Definition enforcement: tools whitelist, model override, `systemPrompt: replace`

**What to build:** The declarative fields in agent definitions take real effect on the nested session. A `tools` field restricts the subagent to exactly that whitelist; omitting it grants all default tools (still minus `task`). A `model` field pins the subagent's model; omitting it inherits the host session's model. `systemPrompt: replace` makes the Markdown body the entire system prompt instead of appending it to Pi's default. A definition whose `model` names an unconfigured model fails loudly with a file-specific error instead of silently falling back.

**Blocked by:** 03

**Status:** ready-for-agent

- [x] With `tools` set, the subagent cannot call any tool outside the whitelist (verified through external behavior)
- [x] With `tools` omitted, the subagent gets all default tools minus `task`
- [x] With `model` set, the nested session runs on the specified model
- [x] With `model` omitted, the nested session inherits the host session's current model (covered by ticket 03's contract test)
- [x] `systemPrompt: replace` yields a body-only system prompt; the default mode still appends to Pi's default prompt
- [x] An unknown model identifier produces an explicit, file-specific error with no silent fallback
