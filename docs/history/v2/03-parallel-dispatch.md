# 03: Parallel dispatch

**What to build:** One `task` call can dispatch several tasks at once. They run concurrently under a configurable cap, results come back in submission order, and a single failing task does not cancel its siblings — the overall call is an error only when every task failed. Cancelling the call cancels every in-flight nested session.

**Blocked by:** 01 (the parallel task entry carries the budget overrides)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A call may carry a list of tasks, each with its own agent, task text, and budget overrides
- [x] Supplying no dispatch shape or more than one is rejected with the valid shapes restated
- [x] Concurrency never exceeds the configured cap (default 4) and is configurable
- [x] Every submitted task eventually runs; none is dropped or starved
- [x] Results preserve submission order regardless of completion order
- [x] Each task reports its own success, failure, or budget-stop state and its own details
- [x] The overall result is an error only when every task failed; partial success returns the successful results
- [x] Cancelling the call aborts every in-flight nested session and each task reports cancellation
- [x] Progress reporting accounts for multiple in-flight tasks
- [x] A single-task call keeps behaving exactly as it does today

## Notes

- Shapes are exclusive: `{ agent, task }` or `{ tasks: [...] }`. Anything else is rejected with the valid shapes restated, before any nested session starts.
- The fan-out cap defaults to 4 and is configured through `PI_NEO_SUBAGENTS_MAX_CONCURRENCY`; an invalid value falls back to the default rather than failing a delegation.
- Ordering is by submission: a bounded worker pool assigns indices, so a slow first task cannot reorder the results.
- Partial failure is an outcome, not an exception: each task carries its own status (`ok`, `budget-stop`, `failed`). The tool result is an error only when every task failed.
- Cancellation propagates through the shared abort signal, so every in-flight nested session stops and reports "Task was cancelled.".
- Live check: two real delegations ran concurrently and both produced their files.
