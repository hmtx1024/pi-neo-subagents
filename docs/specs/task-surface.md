---
id: task-surface
type: module-design
status: draft
title: The task tool surface
parent: architecture
depends-on: [delegation-core, dispatch, governance, rendering, ledger, definitions]
---

# The task tool surface

## Responsibility

The model-facing `task` tool: its public contract, the shapes it accepts, the
consent hook, tool bridging, and the TUI's live view.

- **Contract — exactly one of three shapes**: a single `{ agent, task }`, a
  `tasks` array (parallel), or a `chain` array (sequential). Supplying none
  or more than one is a parameter error that restates the valid shapes.
  Entry parameters may also carry inline `instructions` (ad-hoc), `tools`,
  `model`, and per-call budget overrides (per-call > definition > settings
  default). Parameter *descriptions are load-bearing*: they are the host's
  per-turn token cost, guarded by `test/schema-slimming.test.ts` for size and
  honesty — treat them as behaviour, not comments.
- **Description = discovery + guidance**: it enumerates every available
  definition with name and description, names both definition directories
  (project preferred), and carries delegation guidance — without both, the
  main agent under-delegates and the product delivers no value (see `goal`,
  Principles). The entry point rebuilds it from the inventory and
  re-registers the tool only when the signature changes; a definition added
  mid-session becomes delegable without a reload.
- **Consent hook**: `governance`'s confirmation runs over the entry list
  before anything dispatches — one flow for all three shapes. Denial aborts
  the whole call before any run starts.
- **Bridging**: host extension tools cross into the subagent by default as
  wrappers that execute the *host* implementation with the host session's
  context (its dialogs and permission behaviour included). `task` and
  `create_subagent` are structurally withheld (`BRIDGE_WITHHELD`) even when a
  whitelist names them; a whitelist narrows the bridge set inside
  `delegation-core`; naming a tool the subagent cannot get fails the
  delegation listing the tools — nothing is dropped silently.
- **TUI live widget**: keyed per dispatch, shows each in-flight agent's
  current turn and tool, cleared when the dispatch settles; guarded to TUI
  mode so RPC/print/JSON behaviour is unaffected.
- **Result assembly**: outcomes are rendered by `rendering`, batch usage
  summed via `dispatch`, and every run (including chain steps and ad-hoc
  entries) reported to the entry point's recording callback, which appends
  the ledger entries (see `architecture`, composition root).

## Boundary

- No file writes, no definition creation (that is `create_subagent` on the
  command surface), no direct-run presentation (`command-surface`), no
  execution logic below `dispatch`/`delegation-core`.
- Depends on `dispatch` and `delegation-core` (execution), `governance`
  (consent, settings), `definitions` (inventory and entry parsing), `rendering`
  (outcome text), `ledger` (status types).
