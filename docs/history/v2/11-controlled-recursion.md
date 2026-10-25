# 11: Controlled recursion

**What to build:** A definition can opt into spawning subagents, and a depth limit bounds the tree. Without the opt-in, delegation remains structurally impossible for subagents; with it, a depth-limited spawn fails with a message that names the limit and the current depth, and every result and ledger entry reports its depth.

**Blocked by:** 01 (budgets must bound the extra levels), 03 (the dispatch layer the nested tool reuses)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A definition can declare that it may spawn subagents
- [x] A nested session created for such a definition at a depth below the limit receives the `task` tool, with its own definition enumeration
- [x] A definition without the opt-in never receives the `task` tool
- [x] Exceeding the depth limit fails with a clear message naming the limit and the current depth
- [x] Every result and ledger entry reports the depth it ran at
- [x] Budgets and the ledger apply per level, so nested nesting cannot escape accounting
- [x] The default maximum depth is shallow enough that an accidental opt-in cannot explode into a large tree

## Notes

- Opt-in is a definition field, `allowSubagents: true|false`. Only an opted-in definition gets the nested `task` tool, which is registered through an inline extension in the nested session — nothing else changes about isolation.
- Depth semantics: a top-level delegation is depth 1, its child depth 2. `maxDepth` (settings, default 2) therefore allows exactly one level of nesting by default.
- The tool is registered at every depth for opted-in agents, and the handler refuses an over-deep call with `Delegation depth limit reached: max depth N, this call would run at depth N+1.` — a clear message the nested model sees and can report, rather than a silently missing tool.
- Accounting is uniform: `onRun` fires for every level, so the ledger counts nested runs under their own agent with the depth they ran at (`· depth 1`, `· depth 2`), and budgets apply per level because each level is a normal delegation.
- Ad-hoc agents cannot opt in (there is no definition to carry the flag), so inline delegation never recurses.
- Live check: host → lead (depth 1) → worker (depth 2) produced the file, and the ledger showed both levels.
