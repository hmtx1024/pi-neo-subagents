---
id: command-surface
type: module-design
status: draft
title: Command surface — /subagents and create_subagent
parent: architecture
depends-on: [task-surface, delegation-core, definitions, governance, rendering, ledger]
---

# Command surface — /subagents and create_subagent

## Responsibility

Everything the user and the model do *about* definitions and direct runs —
the `/subagents` command family and the `create_subagent` tool.

- **Strict argument parsing, by design**: options are parsed only *before*
  the agent name (so `--to-context` inside task text stays task text), `--`
  takes the remainder literally, unknown options are rejected with the usage
  line, and `run` never rewrites the task text it was given. Quoted names are
  honoured.
- **List and inspect**: every definition with name, description, tools,
  model, source file, modification time, and override labels.
- **Management — one creation/validation path, shared with
  `create_subagent`**: `new` scaffolds in the resolved project directory
  (validating before any write, never replacing without `--force`), `edit`
  opens the resolved file and saves only edits that re-parse cleanly (an
  invalid edit is never written back), `rm` deletes after confirmation
  (`--yes` for scripts).
- **Direct runs** (`run`): single delegations only — never fan-out or chain.
  The result is presented to the user and kept out of the model's context by
  default; `--to-context` opts in. Command contexts cannot reach host tools,
  so a direct run **cannot bridge**: a definition needing a bridged tool fails
  there with the same list-check message the `task` tool gives, pointing at
  delegation instead. Long results are shortened to the display limit with
  the full-text temp file named. Progress is a status line (`<agent> · turn
  N`), cleared at the end.
- **Stats**: renders the ledger's per-agent table (`formatLedger`) and
  triggers `reset` — which appends the tombstone through the entry point, not
  here.
- **`create_subagent`**: the model-facing creation tool. It owns scope
  (project by default so definitions travel with the repository; `user` only
  when explicitly asked and permitted by `allowUserScopeCreation`), validates
  the generated file before writing, refuses silent overwrite, rejects names
  that would escape the agents directory, and is gated wholesale by
  `allowModelCreatedDefinitions`. A definition it writes is delegable
  immediately.

## Boundary

- Depends on `delegation-core` (direct runs), `definitions` (parse, list,
  create), `governance` (settings gates), `ledger` (stats), `rendering`
  (channel policy and formatting), and `task-surface` — only for
  `task-params`' shared budget-default computation and usage strings, so the
  defaults have exactly one definition (edge: `architecture`).
- Registers no dispatch shapes and never enqueues batches; consent enforcement
  lives on the `task` surface (a direct run is user-initiated in the same
  session, so it does not ask).
