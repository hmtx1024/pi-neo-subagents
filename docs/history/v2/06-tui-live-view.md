# 06: Live subagent view in the TUI

**What to build:** While delegations run, the TUI shows which agents are in flight, which turn each is on, and which tool each is currently using, then clears itself when the dispatch settles. Non-interactive modes are unaffected.

**Blocked by:** 03 (multiple in-flight delegations to display)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A running single delegation shows the agent name, current turn, and current tool
- [x] A parallel dispatch shows one row per in-flight task
- [x] The view updates as turns advance and tools start, without streaming model output
- [x] The view is cleared when the dispatch settles, leaving nothing stale on screen
- [x] The view is only used in TUI mode; JSON, print, and RPC modes register no widget
- [x] A failed or budget-stopped task disappears from the view and is still reported in results

## Notes

- One widget key (`subagents`) holds a line per in-flight delegation: `<agent> · turn N · <tool>`. Rows are seeded as soon as a task is dispatched, so a fan-out shows all its tasks before the first turn completes.
- Updates come from two existing signals: the per-turn progress callback and a new tool-start activity callback from the nested session. No model output is streamed.
- Rows are removed as each task settles, and the widget is cleared when the dispatch finishes (including early returns and failures), so nothing stale remains.
- Guarded by `ctx.mode === "tui"`. The harness showed that the default session mode is `print`, so tests that exercise the view opt into `tui` explicitly.
- Live check: an RPC-mode delegation produced zero `setWidget` records, confirming the guard.
