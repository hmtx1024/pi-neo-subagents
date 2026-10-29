---
id: ledger
type: module-design
status: draft
title: Ledger — the session-log fold
parent: architecture
---

# Ledger — the session-log fold

## Responsibility

Per-session delegation accounting: what each agent cost, how it went, how
long it took — as a **fold over the session log**, not a store of its own.

- **Entry types**: `pi-neo-subagents/run` (one per delegation, any depth)
  and `pi-neo-subagents/reset` (a tombstone). The record schema is versioned
  (`v: 1`) and deliberately *raw* — agent, status, turns, model, depth,
  duration, usage, child session id — so future statistics need a new fold,
  not a new store. **No task text is ever recorded.**
- **The fold** replaces in-memory state wholesale (the entry point replays it
  on `session_start`), aggregating per agent: runs, successes, failures,
  budget stops (counted apart — the outcome taxonomy in `architecture`),
  turns, input/output tokens, cost (from the usage's own cost total), total
  and average duration, and the deepest level the agent ran at.
- **Reset is a tombstone, not a deletion**: `stats reset` appends a reset
  entry, so an emptied ledger stays empty across a resume — the append-only
  log needs no deletion path.
- **`formatLedger()`** renders the stats table and total; it lives here so
  the fold and its presentation stay one unit.

## Boundary

- Pure: no filesystem, no extension API — the *appends* belong to the entry
  point (`recordRun`, `resetLedger` in `index.ts`), which hands entries here.
  Depends on nothing inside the package (only pi-ai's `Usage` type).
- Consumed by the entry point (fold and record types), `command-surface`
  (render/reset), and `task-surface` (status type only).
