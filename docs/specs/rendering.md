---
id: rendering
type: module-design
status: draft
title: Rendering — text by audience and mode
parent: architecture
depends-on: [delegation-core, dispatch]
---

# Rendering — text by audience and mode

## Responsibility

Everything the user or the model sees as text, split by audience, plus the
channel each mode delivers it on.

- **`present()` — command output channel policy**: TUI → notification; RPC →
  `extension_ui_request`; `--print` → stdout; `--mode json` → **stderr**
  (stdout carries the JSON event stream, so plain text must not corrupt it).
  This routing is the contract; every command output goes through it.
- **`formatOutcomes()`** renders the per-task result blocks the *model* sees
  after a dispatch (one block per task with its status and details) —
  consumed by `task-surface`.
- **`formatDirectRun()`** renders a direct run for the *user*, honouring
  `DISPLAY_LIMIT` (2 000 characters inline; the rest was already written to a
  temp file by `delegation-core`, whose notice it repeats). The model-facing
  30 000-character truncation is `delegation-core`'s result contract, not
  this module's.
- **`formatTimestamp()`** — locale-independent timestamps for listings.

Stats text is not here: the ledger renders its own (`formatLedger`), so the
fold and its presentation stay one unit.

## Boundary

- Formatting only — decides nothing about what runs, reads no files, holds no
  state. Depends on outcome *types* from `delegation-core` and `dispatch`
  (type-only edge, see `architecture`).
- Consumed by `task-surface` and `command-surface`; the entry point does not
  render.
