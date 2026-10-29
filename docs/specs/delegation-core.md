---
id: delegation-core
type: module-design
status: draft
title: Delegation core — one nested run
parent: architecture
depends-on: [definitions]
---

# Delegation core — one nested run

## Responsibility

Run exactly one delegation end to end and shape what comes back. Both dispatch
and the direct-run path are thin wrappers over this.

- **Target resolution**: a named definition or an ad-hoc spec (inline
  instructions, optional tools/model/budgets — no file, ledger identity
  `ad-hoc`), and model resolution: a definition's pin resolved against the
  registry, otherwise the host session's model.
- **The nested session** is built in-process through the Pi SDK session
  factory with the provider mirrored from the host, so auth and streaming
  behave identically (rationale: `goal`, Principles). It executes the
  isolation contract stated in `architecture`: only the task text, the
  definition, and the project's context files cross. Skills are the gated
  exception: a definition's `skills` field flips the resource loader from
  "no skills" to Pi's own discovery (user- plus project-level directories),
  with a name list narrowing the index — a name that resolves nowhere is
  silently absent, and a definition without the field loads none. Three
  details worth knowing here: the nested factory registers a **reduced
  `task` tool** — single-shape only (named agent + task + budgets; no
  fan-out, chain, or ad-hoc below the top level) and only when the definition
  opted in via `allowSubagents` — and it actively strips Pi's docs block from
  the nested system prompt.
- **Budgets** are enforced here: turns and tokens at each turn boundary, a
  wall-clock timer that aborts the run. Precedence is per-call value >
  definition value > settings safety-net default (0 = no cap). Hitting a cap
  stops the run and is *not* a failure (outcome taxonomy: `architecture`).
- **Depth**: a top-level delegation is depth 1; the spawn handler refuses a
  child that would exceed `maxDepth` with an error naming both numbers, and
  only runs for definitions with `allowSubagents: true`. Child requests
  inherit defaults, bridges, the persistence callback, the abort signal, and
  the run-recording callback — but not consent checks (see `governance`,
  Known limitation).
- **Result contract**: the final reply as content; beyond 30 000 characters
  it is truncated with an explicit notice and the full text written to a temp
  file whose path is shown; structured details carry turns, usage, model,
  task text, duration, depth, and — on a budget stop — which budget tripped
  with the observed values. Nested usage merges into the session's totals;
  failures surface as error results carrying the underlying error text. A
  budget stop keeps `isError` false.
- **Persistence follows the host**: when the host session has a file, the
  nested session gets one beside it (named `↳ <agent> · <date> <time>`, host
  recorded as `parentSession`); an in-memory host session writes nothing.
- **Cancellation** flows from the caller's abort signal into the nested
  session; progress is reported per turn through a callback, never as a
  stream.

## Boundary

- Depends only on `definitions`. Never parses tool-call parameters (that is
  `task-surface`), never batches (that is `dispatch`), never renders (that is
  `rendering`), and has no direct access to the extension API beyond the
  session factory — UI, consent, and ledger appends arrive as callbacks from
  the surfaces and the entry point.
- Consumed by `dispatch` (fan-out and chains), `task-surface` (single calls),
  `command-surface` (direct runs), and type-only by `rendering` (outcome
  shapes).
