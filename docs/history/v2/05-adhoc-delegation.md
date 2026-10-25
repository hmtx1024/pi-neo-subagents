# 05: Ad-hoc (definition-free) delegation

**What to build:** A task entry can carry inline instructions instead of naming a definition, so one-shot work is delegated without creating a permanent definition file. Ad-hoc work is as capable as a defined agent (tool whitelist, model, budgets), never appears in `/subagents`, is counted in the run ledger under a stable identity, and can never spawn further subagents.

**Blocked by:** 02 (the ledger identity is part of the contract), 03 (the task entry shape)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A task entry may supply inline instructions instead of an agent name
- [x] Inline entries may also set a tool whitelist, a model, and budget overrides
- [x] Nothing is written to disk and no definition appears in `/subagents`
- [x] Ad-hoc runs are recorded in the ledger under one stable identity so their cost stays visible
- [x] An ad-hoc nested session never receives the `task` tool, regardless of depth settings
- [x] An entry that supplies both an agent name and inline instructions, or neither, is rejected with a clear error
- [x] Ad-hoc entries work in single, parallel, and chain dispatch
- [x] Ad-hoc results carry the same details contract as defined delegations

## Notes

- An entry is `{ agent, task }` or `{ instructions, task }` (plus optional `tools`, `model`, budgets). Both or neither is rejected before any nested session starts.
- Ad-hoc delegation does not require any definitions to exist — discovery is skipped entirely, so a project with no `.pi/agents` can delegate immediately.
- Inline agents are built as a synthetic definition whose body is the instructions, so budgets, thinking, tool whitelist, model resolution, and the result contract are identical to named agents.
- Identity for results and the ledger is the fixed label `ad-hoc`, which is how one-off work stays visible without inventing a name.
- Recursion stays structural: nested sessions load no extensions, so an inline agent has no `task` tool regardless of any depth setting.
- Live check: an inline delegation in a project with no definitions produced its file and left no `.pi` directory behind.
