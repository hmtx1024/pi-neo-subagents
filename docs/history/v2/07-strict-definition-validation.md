# 07: Strict definition validation

**What to build:** Definition mistakes stop being silent. A `systemPrompt` value other than `replace` is an error instead of quietly behaving like append, creation rejects tool names that do not exist and models that cannot be resolved, and budget or thinking values are validated. Existing valid definitions keep working unchanged.

**Blocked by:** None (can start immediately)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A `systemPrompt` value other than `replace` is reported as a file-level definition error
- [x] An omitted `systemPrompt` still means append
- [x] Creating a definition rejects tool names that are not currently registered, naming the offending entry
- [x] Creating a definition rejects a model that cannot be resolved against the registry
- [x] Creating a definition rejects invalid budget values and unknown thinking levels
- [x] Discovery stays lenient about tool names, because a definition may be used in a session that lacks an optional tool
- [x] All rejection messages name the definition file or the creation request and the offending field

## Notes

- `systemPrompt` accepts only `replace`; any other value is a file-level error naming the field, so a value that would silently behave like append cannot hide in a definition.
- Creation validates against what the creating session can actually offer: tool names come from the session's registered tools, and models resolve through the same registry used at delegation time.
- `task` is rejected explicitly, with a message explaining that subagents never delegate further — better than accepting a tool the nested session will never receive.
- Discovery stays lenient about tool names on purpose: a definition may be written in a session that lacks an optional tool (MCP, extension tools) and used in another that has it.
- Creation now also accepts the budget and thinking fields, so a scaffolded definition can be complete.
