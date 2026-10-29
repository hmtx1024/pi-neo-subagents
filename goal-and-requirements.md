---
id: goal
type: goal-and-requirements
status: draft
title: pi-neo-subagents — subagent delegation for Pi
references: [spec-v1, spec-v2]
---

# pi-neo-subagents — subagent delegation for Pi

## Goal

Give every Pi session cheap, governed delegation: the main agent hands
self-contained pieces of work to named specialist subagents that run in
isolated nested sessions, so the main conversation stays small, focused, and
cheap — and so delegation stays bounded, auditable, and reviewable.

## Problem

A single Pi conversation carries everything — exploration, review, refactoring
— in one context window. The transcript bloats, the model loses focus, and
token cost climbs, with no way to hand a self-contained sub-task to a
specialist. Delegation must also be cheap to set up (a Markdown file, not
TypeScript) and, once available, governed: an unbounded subagent can burn
tokens for hours, a repository-controlled definition can instruct a model to
run commands, and a typo in a definition must not silently produce a weaker
agent.

## Audience

- **Pi users** who want long work split across isolated specialist sessions,
  and who run specialists directly via `/subagents`.
- **Definition authors** — including non-programmers — who write specialists as
  short Markdown files with frontmatter.
- **The main agent**, which discovers and invokes definitions through the
  `task` tool.

## Capabilities

What the product does today:

1. **Agent definitions** — Markdown with frontmatter in two directories:
   project-level `.pi/agents/` (discovered by walking up from the working
   directory; wins name collisions, labelled in listings) and user-level
   `~/.pi/agent/agents/`. Fields: name, description, tools whitelist, model
   pin, `systemPrompt` replace/append, `maxTurns`, `timeoutMs`, `maxTokens`,
   `thinking`, `allowSubagents`, and `skills` (an opt-in whitelist of skill
   names, or `all`; omitted means the subagent loads none). Definition
   mistakes fail loudly with file-specific errors — no silent fallbacks.
2. **Delegation** — a `task` tool the main agent calls in three exclusive
   shapes: a single task, a parallel fan-out (bounded concurrency, results in
   submission order, partial failure is normal), or an ordered chain with a
   `{previous}` placeholder. Ad-hoc entries delegate inline (instructions plus
   optional tools/model/budgets) without writing a definition file.
3. **Isolation** — a nested session receives only the task text and the
   definition, plus the project's context files: never the host conversation,
   prompt templates, themes, discovered extensions, or Pi's docs. Skills are
   the one gated exception: a definition that declares `skills` loads exactly
   those (or all, with `skills: all`); every other delegation — including all
   ad-hoc entries — stays skill-free.
4. **Budgets** — turns, wall-clock time, and tokens per definition or per
   call, with safety-net defaults. Exceeding one is a first-class outcome: the
   partial reply comes back marked with the budget that tripped — never as a
   failure, never as a silent success.
5. **Definition management** — the model creates definitions through
   `create_subagent` (project-first, validated before writing, no silent
   overwrite); the user manages them through `/subagents new|edit|rm`.
6. **Consent** — the first use of a project-level agent in a session is
   confirmed when a dialog UI exists, remembered per agent per session;
   non-interactive sessions never hang (`ask` proceeds, `deny` refuses).
   Model-authored definitions and user-scope writes are separately gated by
   settings.
7. **Controlled recursion** — a definition opts in with
   `allowSubagents: true`; a depth limit (default 2) bounds the tree, ad-hoc
   entries never recurse, and `task` / `create_subagent` never otherwise cross
   into a nested session.
8. **Direct runs** — `/subagents run <name> <task>` presents the result to
   the user only, with `--to-context` to feed the model instead; plus
   list/inspect output and a per-session run ledger readable via
   `/subagents stats` (survives a resume; `reset` leaves a tombstone).
9. **Observability** — every delegation (single, fan-out, chain step) is
   recorded per agent: runs, failures, budget stops, turns, tokens, cost,
   duration, depth. In the TUI, in-flight delegations show live (agent, turn,
   current tool).
10. **Bridged tools** — host extension tools (search, browser, MCP-backed)
    cross into subagents by default and run with the host session's own
    context; a `tools` whitelist narrows strictly and may name nothing the
    subagent cannot get.
11. **Two test layers** — a hermetic suite at a single session seam (scripted
    model, offline) and an environment-gated live-model smoke suite excluded
    from `npm test`.

## Non-goals

- **First-class resume/fork of nested sessions.** Each delegation's transcript
  is already saved as a child session when the host session persists —
  replaying a run is Pi's own session browser. Making nested sessions directly
  resumable or forkable as a product feature is excluded by decision.
- **Cross-machine / cross-repository definition sync.** The project and user
  agent directories are the whole distribution model.

## Principles

- **No silent fallbacks.** An invalid definition value is a loud, file-specific
  error; discovery stays lenient only where a definition may legitimately run
  in a session that lacks an optional tool.
- **Budget stop ≠ failure.** Cut-short work is reported as cut-short, with the
  budget named and the partial reply preserved.
- **Isolation is contextual, not process-level.** Nested sessions run in-process
  and share the host's model configuration and credentials (confirmed: the Pi
  SDK's session factory is the intended seam; context isolation is the goal,
  process isolation never was).
- **The session log is the durable store.** No sidecar files, schemas, or
  migrations: the ledger is a fold over entries the extension appends, and a
  delegation's persistence follows the host session's own persistence.
- **Project-first, reviewable.** Definitions default into the repository so
  they travel with it and can be reviewed; writes outside the project require
  an explicit opt-in.
- **Automation never hangs.** Every confirmation has a defined non-interactive
  answer.
- **The `task` tool description is product behaviour.** Its enumeration of
  definitions plus delegation guidance is what makes the main agent delegate
  at all — it is guarded by tests like behaviour, not treated as a comment.
- **One test seam.** Behaviour is asserted only at the session boundary; a
  requirement that seems to need a new seam should be reshaped to be observable
  there instead.
