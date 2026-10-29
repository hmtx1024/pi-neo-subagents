---
id: dispatch
type: module-design
status: draft
title: Dispatch — fan-out and chains
parent: architecture
depends-on: [delegation-core]
---

# Dispatch — fan-out and chains

## Responsibility

Execute a *batch* of delegations over `delegation-core`, with the failure
semantics that make batching safe. Two shapes, both top-level only (the
nested `task` tool is single-shape — see `delegation-core`):

- **Parallel** (`dispatchParallel`): bounded concurrency — default 4, raised
  or lowered by `PI_NEO_SUBAGENTS_MAX_CONCURRENCY`. Results come back in
  **submission order** regardless of completion order, each as its own outcome
  with its own status (`ok | budget-stop | failed`). One failing task never
  cancels its siblings; the batch is an error only when *every* task failed.
  Cancelling the call aborts every in-flight run.
- **Chain** (`dispatchChain`): strictly sequential, so the fan-out cap does
  not apply. `{previous}` in a step's task is substituted with the prior
  step's reply; using it in the first step is rejected before anything runs.
  The chain stops at the first step that fails **or is cut short by a
  budget** — later steps are reported `skipped` and never act on a missing
  input.
- **Usage aggregation** for a batch (`totalUsage`) lives here too.

## Boundary

- Depends only on `delegation-core`. Never talks to the UI, the tool
  description, or rendering; never parses raw tool parameters (`task-surface`
  owns the three exclusive shapes and rejects calls that supply none or more
  than one) and never formats results (`rendering` does).
- Consumed by `task-surface` only; `governance` takes its batch shape
  type-only so consent applies uniformly to every entry (edge:
  `architecture`).
