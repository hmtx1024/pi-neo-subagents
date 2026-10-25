# 01: Execution controls — turn, time, token budgets, and thinking level

**What to build:** An agent definition (and a single task entry) can cap a delegation: maximum turns, wall-clock timeout, token budget, and thinking level. Exhausting any budget stops that nested session, returns the partial reply it produced, and marks the result as budget-exhausted with the specific budget named alongside the observed values. Cutting work short is a first-class outcome, never a silent success and never confused with a failure.

**Blocked by:** None (can start immediately)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A definition can declare max turns, timeout, token budget, and thinking level; omitted fields mean unlimited and inherited thinking
- [x] A task entry can override each budget per call, and the override wins over the definition
- [x] Hitting the turn cap stops the nested session at a turn boundary and returns its latest reply
- [x] Hitting the wall-clock timeout aborts the nested session and returns its latest reply
- [x] Hitting the token budget stops the nested session and returns its latest reply
- [x] A budget stop is reported as a successful delegation whose details name the exhausted budget and the observed value, so it is distinguishable from a failed delegation
- [x] Thinking level is applied to the nested session and echoed in the result details
- [x] Budget and thinking values are validated; invalid values are file-level definition errors when they come from a definition and tool parameter errors when they come from a call
- [x] Existing definitions without budgets keep today's unbounded behaviour

## Notes

- Enforcement points: the turn and token budgets are checked when an assistant message ends and the run would continue (`stopReason: "toolUse"`), so a turn that already finished the conversation is never mislabelled as cut short. The timeout is a wall-clock timer.
- The reply reported on a stop is the text captured **at** the stop, never a later turn's output.
- The abort is cooperative: with a real provider the loop stops at that turn (verified live: `maxTurns: 1` returned the first turn's text plus the budget note). The hermetic faux provider ignores aborts, so the tests assert the reported outcome (partial reply, frozen turn count, named budget) rather than the absence of a further scripted turn.
