---
id: spec-v2
type: goal-and-requirements
status: done
title: "Spec: pi-neo-subagents v2 — Parallelism, Budgets, and Managed Definitions"
parent: goal
references: [spec-v1]
---

# Spec: pi-neo-subagents v2 — Parallelism, Budgets, and Managed Definitions

Status: delivered (tickets 01–12)
Tickets: `.scratch/pi-neo-subagents-v2/issues/` (01–12, numbered in dependency order)
Scope source: v1 has shipped (spec `docs/specs/subagents.md`, tickets 01–09). v2 scope is derived from the v1 live-test report (`.scratch/pi-neo-subagents/manual-test-report.md`), the deferred items listed in v1's "Out of Scope", and the v2 plan review.
Living record: `goal-and-requirements.md` (repo root) — corrections for post-v2 changes (0.1.10) are marked inline below.

## Problem Statement

v1 makes delegation work: named Markdown agent definitions, a `task` tool, isolated nested sessions, direct runs, and project-first definition creation. Using it every day exposes four classes of limitation.

**It cannot fan out.** Every delegation is serial. A user who asks for "two subagents, one writes the Python hello world, one writes the Go one" gets a sequential queue, and multi-file or multi-angle work (review five modules, research three options) costs wall-clock time that the host agent would otherwise parallelize. The model already assumes parallelism is available — a live run explicitly told the user "并行委派" — so the product's mental model and its behaviour disagree.

**A delegation has no ceiling.** A subagent has no turn limit, no wall-clock limit, and no token limit. In a live run, a single delegation to a slow model generated for more than ten minutes with no way to bound it except interrupting the host, and the host's abort does not always land before the tool call starts, so the work continued and its result arrived after the user had moved on. Cost and latency are ungoverned.

**Definitions are permanent, and only the model can manage them.** One-shot work ("write a hello world") has no reason to create a file that lives in the repository forever; v1 offers no way to delegate once without a definition. Conversely, the user has no first-class way to create, edit, or delete definitions — `create_subagent` is model-facing only, so management means editing Markdown by hand. And when a definition is wrong — an unknown tool name, a `systemPrompt` value that is not `replace` — the failure is silent: `systemPrompt: merge` silently behaves like append, and an unknown tool name silently disappears from the whitelist.

**Nobody can see the cost, and nothing is authorized.** There is no aggregate view of what delegation costs per agent, no live view of what a running subagent is doing beyond a turn counter, and no confirmation when a project-level agent (which can instruct a model to run commands) is invoked for the first time. The model can author definitions that carry `tools: bash` without any gating. Controlled recursion is also impossible: a subagent that would benefit from splitting its own work has no way to do so, because the `task` tool is structurally withheld.

Two smaller gaps compound the rest: definitions are only found when Pi runs exactly at the project root, and the hermetic test suite cannot detect any of the defects above — every one of the eight problems found in the v1 live test passed the entire suite.

## Solution

v2 turns delegation from "works" into "governed".

**Dispatch shapes.** `task` gains parallel and chain dispatch alongside the existing single call: an array of tasks runs concurrently up to a configurable cap, and a chain runs steps in order with a `{previous}` placeholder for the prior step's reply. Partial failure is normal: each task reports its own result, and one failure never cancels its siblings.

**Budgets.** Definitions and individual calls can set `maxTurns`, `timeoutMs`, and `maxTokens`. Exceeding a budget stops that subagent, returns the partial reply it produced, and marks the result as budget-exhausted with the specific budget named — never a silent success.

**Ad-hoc delegation.** `task` accepts a definition-free call: inline instructions plus optional tool whitelist, model, and budget. One-shot work stops creating permanent files. Definitions remain the way to share and reuse specialists.

**Managed definitions.** `/subagents new`, `/subagents edit`, and `/subagents rm` give the user the same power `create_subagent` gives the model, all going through one creation/validation path with project-first placement.

**Observability.** A per-session run ledger accumulates turns, tokens, cost, duration, and outcome per agent, readable through `/subagents stats`. In the TUI, a running subagent shows its current turn and current tool in a live widget instead of a single status line.

**Authorization and strictness.** Project-level agents (and model-authored definitions) are confirmed before first use when a UI is available, with explicit settings for the non-interactive case. Definition validation becomes strict: unknown tool names, non-`replace` `systemPrompt` values, and unknown models are errors, not silent fallbacks.

**Controlled recursion.** A definition opts in with `allowSubagents: true`, and a global depth limit (default 2 levels total) bounds the tree. Delegation without opt-in stays structurally impossible.

**Discovery that matches how people work.** Definitions are found by walking up from the working directory to the nearest `.pi/agents`, so running Pi in a subdirectory finds the repository's agents. Creation targets that same directory.

**A live-model smoke suite** runs the real path (no definitions → create → delegate → parallel) against a cheap real model, gated by an environment variable and excluded from the default test run, so prompt-guidance and end-to-end regressions cannot pass unnoticed again.

## User Stories

1. As a pi user, I want several subagents to run concurrently in one tool call, so that multi-part work finishes faster than a sequential queue.
2. As the main agent, I want to dispatch a list of tasks in one call, so that I do not have to re-derive shared instructions per call.
3. As a pi user, I want concurrency capped by configuration, so that a large fan-out cannot exhaust rate limits or my machine.
4. As the main agent, I want one failed parallel task to leave its siblings running, so that a single bad task does not discard the rest of the work.
5. As the main agent, I want each parallel task's result reported separately, so that I can attribute outcomes to tasks.
6. As the main agent, I want a chained dispatch where each step can reference the previous reply, so that I can express reviewer-then-fixer pipelines in one call.
7. As the main agent, I want a chain to stop at the first failing step, so that later steps do not act on a missing input.
8. As the main agent, I want a clear error when a chain step references `{previous}` with nothing before it, so that malformed pipelines fail fast.
9. As a pi user, I want to cancel a parallel dispatch as a whole, so that I can stop a fan-out with one action.
10. As an agent definition author, I want to declare a maximum number of turns, so that a wandering agent stops instead of burning tokens.
11. As an agent definition author, I want to declare a wall-clock timeout, so that a slow model cannot hold a delegation open indefinitely.
12. As an agent definition author, I want to declare a token budget, so that a chatty agent cannot spend beyond an expected amount.
13. As the main agent, I want to override budgets per call, so that a single task can be tighter or looser than its definition.
14. As a pi user, I want a budget-exhausted subagent to return what it produced plus which budget tripped, so that partial work is not silently discarded.
15. As a pi user, I want a budget-exhausted result to be visibly marked, so that I never mistake truncated work for a completed task.
16. As the main agent, I want to delegate one task without creating a definition file, so that one-shot work leaves no repository residue.
17. As the main agent, I want an ad-hoc delegation to accept its own tool whitelist and model, so that it is as capable as a defined agent.
18. As a pi user, I want ad-hoc delegations to appear in the run ledger under a distinguishable identity, so that their cost is still visible.
19. As a pi user, I want the ad-hoc path to be unable to spawn further subagents, so that inline work cannot create an unbounded tree.
20. As a pi user, I want `/subagents new` to scaffold a correct definition in the project directory, so that I do not hand-write frontmatter.
21. As a pi user, I want `/subagents edit <name>` to open the definition's file for editing, so that iteration stays in one place.
22. As a pi user, I want `/subagents rm <name>` to delete a definition after confirmation, so that cleanup does not require filesystem knowledge.
23. As a pi user, I want definition creation and editing to validate before writing, so that a broken definition never replaces a working one.
24. As a pi user, I want `/subagents stats` to show per-agent runs, turns, tokens, cost, and duration for this session, so that I can see what delegation actually costs.
25. As a pi user, I want `/subagents stats` to include failed and budget-exhausted runs, so that failures are counted rather than invisible.
26. As a pi user, I want to reset the ledger for a session, so that measurements can start from a known point.
27. As a pi user in the TUI, I want to see which agent, turn, and tool a running subagent is on, so that a long delegation is legible instead of opaque.
28. As a pi user in the TUI, I want the live subagent view cleared when a delegation ends, so that stale state never remains on screen.
29. As a pi user in a non-interactive mode, I want the same behaviour without the widget, so that scripts are unaffected by rendering.
30. As a pi user, I want to be asked before a project-level agent is used for the first time, so that a repository-controlled prompt cannot run commands without my consent.
31. As a pi user, I want to control that confirmation through a setting, so that trusted repositories do not prompt every session.
32. As a pi user, I want a defined answer for non-interactive modes, so that automation does not hang on a prompt that cannot be answered.
33. As a pi user, I want model-authored definitions to be gated by a setting, so that I can forbid the agent from creating agents.
34. As a pi user, I want user-scope writing to be disabled by default, so that the global configuration cannot change without an explicit opt-in.
35. As an agent definition author, I want an unknown tool name to be an error, so that a typo cannot silently produce a weaker agent.
36. As an agent definition author, I want any `systemPrompt` value other than `replace` to be an error, so that a value that does nothing is not silently ignored.
37. As an agent definition author, I want an unknown `model` inside a definition to fail at creation time, so that I learn immediately rather than at first delegation.
38. As an agent definition author, I want to opt a definition into spawning subagents, so that decomposable work can be expressed without opening recursion everywhere.
39. As a pi user, I want recursion bounded by a depth limit, so that an opt-in cannot explode into an unbounded tree.
40. As a pi user, I want a depth-limited delegation to fail with a clear message, so that I can see why a nested spawn was refused.
41. As a pi user, I want delegation results to report their depth, so that I can audit the shape of a run.
42. As a pi user running Pi in a subdirectory, I want my repository's definitions to be found, so that I do not have to start Pi at the repository root.
43. As a pi user, I want created definitions to land in the same directory discovery uses, so that creation and discovery never disagree.
44. As a pi user, I want `/subagents` to show each definition's source file and modification time, so that I can tell which file a definition came from and whether it is current.
45. As a pi user, I want a small `thinking` field on definitions, so that a deep-reasoning agent can be declared without a separate wrapper.
46. As a maintainer, I want a live-model smoke run covering the zero-definition → create → delegate → parallel path, so that guidance regressions are caught before release.
47. As a maintainer, I want the live suite excluded from the default test command, so that normal development stays offline and fast.
48. As a maintainer, I want budget, dispatch-shape, and authorization behaviour covered at the existing session seam, so that v2 does not add new test seams.

## Implementation Decisions

**Modules.** v2 changes the definition module (parsing, validation, discovery, create/delete), the delegation module (request shape, budgets, dispatch), the nested runner (budget enforcement, depth, thinking level), and the extension entry point (tool parameters, command surfaces, settings, TUI widget). One new internal module owns the run ledger (per-session aggregates; no persistence). No new seams are introduced.

**Dispatch model.** The `task` tool takes exactly one of three exclusive shapes: a single task, a `tasks` array (parallel), or a `chain` array (sequential). Supplying none or more than one is a parameter error with the valid shapes restated. Parallel concurrency is capped (default 4, configurable), and results preserve submission order regardless of completion order.

**Partial failure.** A parallel dispatch returns one result block per task, each carrying its own success/failure state and details; the overall tool result is an error only when every task failed. A chain stops at the first failed step and returns the steps that ran plus the failing step's error. Cancellation of the dispatch aborts every in-flight nested session.

**Budgets.** Budget fields live in the definition (`maxTurns`, `timeoutMs`, `maxTokens`) and can be overridden per call (`maxTurns`, `timeoutMs`, `maxTokens` on the task entry). Enforcement: turns and tokens are checked at each turn boundary and stop the nested session; the timeout is a wall-clock timer that aborts it. A budget stop returns the subagent's latest reply, `isError: false` (the delegation itself worked), and details naming the exhausted budget plus the observed values so far. This keeps "the work was cut short" distinguishable from "the delegation failed".

**Ad-hoc delegation.** A task entry may carry `instructions` (and optionally `tools`, `model`, budgets) instead of an `agent` name. The nested session is built from those instructions exactly as a definition body would be, with no file written and no `/subagents` entry. Ad-hoc runs are always depth-limited to the top level (they never receive the `task` tool) and appear in the ledger under a fixed ad-hoc identity.

**Definition management.** `/subagents new`, `/subagents edit`, and `/subagents rm` use one creation/validation path shared with `create_subagent`; `new` prompts for name and description when omitted, `edit` opens the resolved file, `rm` asks for confirmation. Creation refuses to overwrite without an explicit flag, and validation runs before any write, as in v1.

**Authorization.** Before the first use of a project-level agent in a session, a confirmation is requested when a dialog-capable UI exists; the answer is remembered per session per agent. Settings: `confirmProjectAgents` (default on), `allowModelCreatedDefinitions` (default on), `allowUserScopeCreation` (default off), `maxDepth` (default 2). In modes without a UI, confirmation is treated as denied only when `confirmProjectAgents` is explicitly configured to deny-without-UI; the default is to proceed so automation never blocks. *(Corrected during spec-graph import: no warning is actually recorded — the answer is silently remembered like a UI confirmation; the code has no warning path.)* (This is the one behaviour that must be written down explicitly because it differs between interactive and scripted use.)

**Strict validation.** `systemPrompt` accepts only `replace`; an unknown or unavailable `model` fails at creation; `tools` entries must match a currently registered tool name at creation time (warn-free hard error) while discovery stays lenient, because a definition may legitimately be used in a session that lacks an optional tool.

**Recursion.** A definition opts in with `allowSubagents: true`. When a nested session is created at depth `< maxDepth` for such a definition, the `task` tool is registered inside it with its own enumeration of definitions. Exceeding the depth limit produces a clear error naming the limit and the current depth. Results and ledger entries carry `depth`.

**Discovery.** Project discovery walks up from the working directory to the nearest directory containing `.pi/agents`, stopping at the filesystem root. Creation writes into that same directory, or creates `<cwd>/.pi/agents` when no ancestor has one. User-level discovery is unchanged.

**Run ledger.** In-memory per session: `{ agent, depth, runs, failures, budgetStops, turns, inputTokens, outputTokens, cost, totalDurationMs }`. Updated from delegation outcomes (which already carry usage and duration). `/subagents stats` renders a table; `/subagents stats reset` appends a tombstone. *(Corrected during spec-graph import, 0.1.10: the ledger is now a fold over pi's session log — one raw record per delegation, replayed on `session_start` — so stats survive a resume; the in-memory ledger is the view. See `ledger`.)*

**TUI rendering.** A widget keyed per dispatch shows the agent name, current turn, and current tool for in-flight subagents, updated from the existing progress callback and tool-event subscription; it is cleared when the dispatch settles. Guarded by TUI mode; a no-op elsewhere.

**Live smoke suite.** A separate, environment-gated suite (`PI_NEO_SUBAGENTS_LIVE=1`) runs the real path against a cheap configured model: zero definitions → create two definitions → parallel delegate → assert files, results, and ledger. It is excluded from the default test command and never runs in CI without the variable.

## Testing Decisions

A good test asserts observable behaviour at a boundary the user or the model can see: tool-result content and details, visible messages, recorded UI calls, files on disk, and what the model receives in its transcript. Tests never reach into module internals, never assert on private state, and never depend on wall-clock timing beyond generous bounds.

The single seam stays: a full in-memory agent session created through the SDK with pi-ai's scripted faux provider, the real extension entry loaded by Pi's normal extension loader, and a recording UI context. v2 extends the harness rather than adding seams: the recording UI gains scripted `confirm` answers and recorded `setWidget` calls, and the scripted model gains deferred-response gates so concurrency and interleaving are observable deterministically.

Coverage plan, by area:

- **Dispatch shapes** — single (existing tests keep passing), parallel (completion order vs result order, concurrency cap, one failure among successes), chain (`{previous}` substitution, stop at first failure, `{previous}` misuse).
- **Budgets** — turn cap, token cap, timeout (short values with a delayed scripted response), partial reply returned, detail names the budget, `isError` stays false.
- **Ad-hoc** — delegation succeeds with no file created, ledger identity, no `task` tool inside it.
- **Management commands** — `new` writes a valid project definition, `edit` resolves the right file, `rm` removes it after confirmation and never without it.
- **Authorization** — confirmation asked once per agent per session, remembered, respected in denial, settings respected, non-interactive path does not hang.
- **Strict validation** — unknown tool name, non-`replace` `systemPrompt`, unknown model: each a creation error and a discovery error where applicable.
- **Recursion** — opt-in spawns, depth limit refuses with a clear message, depth reported in results.
- **Discovery** — nested working directory finds the ancestor `.pi/agents`; creation targets the same directory.
- **Ledger and stats** — runs, failures, budget stops, tokens and cost accumulate; reset clears; output renders.
- **TUI widget** — recorded widget calls show turn and tool, and a clear call at the end; JSON/print modes record no widget calls.
- **Live suite** — separate, env-gated, not part of `npm test`.

Prior art: the v1 suites (`inventory`, `task-tool`, `result-contract`, `definition-enforcement`, `direct-run`, `hardening`, `definition-parsing`, `run-parsing`, `output-modes`, `skill-isolation`, `errors`, `create-subagent`) already demonstrate each pattern: scripted tool calls, captured transcripts, recorded UI output, filesystem assertions, and non-interactive mode capture. v2 tests follow those shapes.

## Out of Scope

- Publishing to npm and the Pi package gallery (manifest already conforms; release mechanics are separate). *(Corrected during spec-graph import: the package has been published to npm since 0.1.x; release mechanics live in `RELEASING.md`.)*
- `/subagents lint` and a bundled library of example agents.
- Persisting, resuming, or forking nested subagent sessions; the ledger is in-memory only. *(Corrected during spec-graph import, 0.1.10: a delegation's transcript is now saved as a child session when the host session persists, and the ledger folds the session log across a resume. What remains excluded is first-class resume/fork of nested sessions — recorded in `goal`, Non-goals.)*
- Model pools, automatic cost routing, and per-task model selection policies.
- Cross-machine or cross-repository synchronization of definitions.
- Any GitHub / issue-tracker publishing workflow.
- The known host-side cancel race (an abort that lands before the host starts the tool call does not prevent execution); it is tracked upstream and only a note here.

## Further Notes

- The v1 live test is the reason several v2 items exist: silent degradation, unbounded runs, and guidance dead ends were all invisible to a hermetic suite that passed 42 tests. The live suite is therefore product infrastructure, not a nice-to-have.
- Budgets are deliberately non-fatal: cutting work short is a first-class outcome, distinct from failure. Every surface that reports outcomes must preserve that distinction.
- Parallelism changes the failure surface more than any other item: concurrency caps, cancellation fan-out, and partial-failure reporting must land before chained dispatch is layered on.
- Recursion stays opt-in and depth-bounded; the safest default remains "subagents cannot spawn subagents".
- The single seam is a deliberate constraint. If a v2 requirement seems to need a new seam, the requirement should be reshaped to be observable at the session boundary instead.
