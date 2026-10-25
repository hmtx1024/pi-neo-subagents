# 02: Run ledger and `/subagents stats`

**What to build:** A per-session ledger records every delegation — turns, tokens, cost, duration, and outcome (success, failure, budget stop) — keyed by agent identity. `/subagents stats` renders it as a table and `stats reset` clears it. Users can finally see what delegation costs, including the runs that failed or were cut short.

**Blocked by:** 01 (the ledger must count budget stops)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] Every delegation updates the ledger with run count and total turns
- [x] Input/output tokens and cost accumulate per agent
- [x] Total and average duration accumulate per agent
- [x] Failures are counted separately from successes
- [x] Budget stops are counted separately from failures, using 01's outcome distinction
- [x] `/subagents stats` renders one row per agent with runs, failures, budget stops, turns, tokens, cost, and duration
- [x] `/subagents stats reset` clears the ledger for the session
- [x] An empty ledger renders a clear "no runs yet" state instead of an empty table
- [x] Stats output respects the existing non-interactive output contract (stdout in print mode, stderr in JSON mode)
- [x] The ledger is per session and starts empty in a new session

## Notes

- The ledger is session-scoped and reset on `session_start`, so a new session always starts empty.
- Recording happens where the outcome exists: the single path records the delegation result, and the fan-out/chain paths record every step (skipped steps are not runs).
- A failed lookup (unknown agent) is recorded under the requested name, so a typo is visible in the ledger instead of vanishing.
- Average duration only counts runs that reported a duration, so failures with no timing cannot drag the average to zero.
- Live check: one real fan-out produced two ledger rows with runs, turns, tokens, cost, and average time, plus the total.
