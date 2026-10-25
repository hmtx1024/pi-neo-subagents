# 04: Chained dispatch

**What to build:** A `task` call can run a chain of steps in order, where each step can inject the previous step's reply through a `{previous}` placeholder. The chain stops at the first failing step and returns the steps that ran plus the failure, so a reviewer-then-fixer pipeline fits in one call.

**Blocked by:** 03 (shared dispatch layer and partial-failure semantics)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] A call may carry a chain of steps, each with an agent, task text, and budget overrides
- [x] Steps run sequentially in the declared order and each completes before the next starts
- [x] A `{previous}` placeholder is replaced by the immediately preceding step's reply
- [x] A `{previous}` reference in the first step is rejected with a clear error
- [x] The chain stops at the first failing step and does not run later steps
- [x] A failed chain returns the completed steps plus the failing step's error
- [x] Chain results carry per-step details (turns, tokens, budget outcome) in declared order
- [x] A chain is unaffected by the parallel concurrency cap and never interleaves with its own steps

## Notes

- `{previous}` is substituted into every occurrence inside a step's task text; the placeholder is rejected in the first step before any nested session starts.
- Steps are strictly sequential: one nested session exists at a time, so the fan-out cap never applies to a chain.
- A budget stop halts the chain too: a cut-short step still produced a partial reply, and handing that to the next step silently would be worse than stopping. Its status stays `budget-stop` (not `failed`), and the remaining steps are reported as `skipped`.
- The tool result is an error only when the first step failed (nothing produced a reply). A later failure or a budget stop still returns a normal result whose text names each step's status and whose details carry every step, so the model and the UI see the whole pipeline.
- Live check: a two-step chain ran on real models; the second step consumed the first step's reply through `{previous}`.
