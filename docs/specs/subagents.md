---
id: spec-v1
type: goal-and-requirements
status: done
title: "Spec: pi-neo-subagents — Subagents Plugin for Pi (v1, as shipped)"
parent: goal
references: [spec-v2]
---

# Spec: pi-neo-subagents — Subagents Plugin for Pi

Status: delivered (v1 shipped; tickets 01–09)
Scope source: the design tree agreed in the grilling session (Q1–Q13, all settled).
Successor: `docs/specs/subagents-v2.md` (parallelism, budgets, managed definitions).
Living record: `goal-and-requirements.md` (repo root) — the sections below describe v1 as shipped,
including its then-scope; current behaviour lives in the spec graph (corrections are marked inline).

## Problem Statement

Pi users run long, context-heavy tasks with a single agent conversation. Everything — exploration, code review, research, refactoring — flows through one context window, so the transcript bloats, the model loses focus, and token costs climb. Users who want to delegate work to specialized, isolated agents (the way Claude Code users delegate to subagents) have no way to do this in Pi: there is no mechanism to define named specialist agents, no tool for the main agent to dispatch a task to them, and no command for the user to invoke one directly.

Users also want delegation to be cheap to set up: a non-programmer should be able to write a new specialist agent as a short Markdown file, not by writing TypeScript.

## Solution

A Pi extension (`pi-neo-subagents`) that adds subagent delegation to any Pi session.

Users define named **agent definitions** as Markdown files with frontmatter, in a project-level resource directory and a user-level resource directory. Each definition declares the agent's name, description, allowed tools, and optional model override; the Markdown body is the agent's specialization instructions.

The main agent discovers these definitions through a model-callable **`task` tool** whose description dynamically enumerates every available agent with its name and description plus delegation guidance. When the main agent decides a piece of work should be delegated, it calls `task` with an agent name and a self-contained task description. The plugin runs the task as a **nested, fully isolated agent session** (its own conversation history and system prompt, shared model configuration and credentials), and returns the subagent's final reply into the main context along with usage metadata.

The user gets a **`/subagents` command** family: list all defined agents, inspect one agent, and run an agent directly with a task — the direct-run result is presented to the user and kept out of the model's context by default, with a run option that instead sends the result into the model's context.

In v1, delegation is serial and one level deep: results come back as tool results, subagent conversations are ephemeral, and there is no recursion.

## User Stories

1. As a pi user, I want the main agent to delegate self-contained sub-tasks to named specialist subagents, so that my main conversation stays small and focused.
2. As a pi user, I want to define a new specialist agent by writing a Markdown file with frontmatter, so that I can add agents without writing TypeScript.
3. As an agent definition author, I want to declare the agent's name in frontmatter, so that the main agent can refer to it unambiguously.
4. As an agent definition author, I want the agent's name to default to its filename when I omit it, so that trivial definitions stay trivial.
5. As an agent definition author, I want to write a one-line `description` in frontmatter, so that the main agent knows when this agent is the right one to delegate to.
6. As an agent definition author, I want to write the agent's specialization, tone, and task rules as the Markdown body, so that I author instructions in a comfortable format.
7. As an agent definition author, I want to restrict an agent to an explicit tool whitelist via a `tools` field, so that e.g. a reviewer agent cannot mutate files.
8. As an agent definition author, I want agents that omit `tools` to receive all default tools, so that simple definitions work without extra configuration.
9. As an agent definition author, I want to pin an agent to a specific model via a `model` field, so that cheap or specialized agents stay cheap or specialized.
10. As an agent definition author, I want agents that omit `model` to inherit the main session's current model, so that definitions work with zero configuration.
11. As an agent definition author, I want an explicit `systemPrompt: replace` escape hatch, so that advanced agents can fully own their system prompt instead of appending to Pi's default.
12. As an agent definition author, I want my definitions to live in a project-level resource directory, so that agents travel with the repository and the team.
13. As a pi user, I want my personal agent definitions in a user-level resource directory, so that I can use the same agents across projects.
14. As a pi user, I want project-level definitions to override user-level definitions with the same name, so that repositories can specialize shared agents.
15. As a pi user, I want the `/subagents` list to show when a definition is overridden, so that I am never surprised about which definition is active.
16. As an agent definition author, I want broken frontmatter or an unknown model to be reported as a clear, file-specific error, so that I fix my definition instead of debugging silent misbehavior.
17. As the main agent, I want the `task` tool's description to enumerate every available agent with its name and description, so that I can discover delegation targets without extra round-trips.
18. As the main agent, I want the `task` tool description to include delegation guidance, so that I recognize when to delegate instead of doing work inline.
19. As the main agent, I want the agent enumeration to refresh when definitions change, so that newly added agents become delegable in the same session.
20. As the main agent, I want to call `task` with an agent name and a task description, so that I can dispatch work in a single tool call.
21. As the main agent, I want the subagent to receive only the task text and none of my conversation history, so that context does not leak and the delegation stays cheap.
22. As the main agent, I want the task description contract to require self-contained input, so that subagents can act without hidden background.
23. As the main agent, I want the subagent to run with its own isolated conversation and system prompt built from the definition, so that its reasoning does not pollute my context.
24. As the main agent, I want the subagent's final reply returned as the `task` tool result content, so that I can incorporate the outcome into my next step.
25. As the main agent, I want oversized results truncated at 30,000 characters with a pointer to the full result written to disk, so that one delegation cannot blow up my context.
26. As a pi user, I want the full untruncated subagent result persisted to a file when truncation occurs, so that no work is lost.
27. As a pi user, I want the `task` tool result to carry structured details (turn count, token usage, model, task, duration), so that I can audit what a delegation cost.
28. As a pi user, I want nested token usage merged into session usage totals, so that my usage accounting stays accurate.
29. As the main agent, I want coarse progress updates while a subagent runs (e.g. current turn count), so that I know a delegation is alive rather than hung.
30. As a pi user, I want to run a subagent myself via `/subagents run <name> <task>`, so that I can use specialists directly without asking the main agent.
31. As a pi user, I want direct-run results presented to me and kept out of the model's context by default, so that manual runs do not cost me context.
32. As a pi user, I want a direct-run option that sends the result into the model's context, so that the main agent can build on the outcome when I want it to.
33. As a pi user, I want `/subagents` to list all defined agents with name, description, tools, and model, so that I can see my delegation inventory at a glance.
34. As a pi user, I want `/subagents <name>` to show one agent's full definition, so that I can review exactly what a specialist will do.
35. As a pi user, I want the `task` tool hidden from subagents themselves, so that delegation cannot recurse in v1.
36. As a pi user, I want to cancel a running subagent the same way I cancel any Pi work, so that I am never stuck waiting on a delegation.
37. As a pi user, I want subagent sessions cleaned up deterministically after each run, so that delegations do not leak memory or file handles across reloads and session switches.
38. As a pi user running Pi in non-interactive modes (RPC/JSON/print), I want delegation to work with behavior intact and rendering skipped, so that scripts and automations can use subagents.
39. As a pi user, I want the extension packaged as a standard npm-style package, so that installation is a normal Pi extension install and distribution can later become a Pi package.
40. As the main agent, I want the `task` tool description to name the definition directories and the preferred scope, so that I never have to guess where definitions live.
41. As the main agent, when no existing definition fits, I want to create one in a single tool call instead of hand-writing a file, so that delegation is not a dead end.
42. As a pi user, I want model-created definitions to land in the project directory by default, so that they travel with the repository instead of polluting my global configuration.
43. As a pi user, I want user-scope creation to require an explicit `scope`, so that changes outside the project are always intentional.
44. As a pi user, I want creation to validate the definition and refuse to overwrite an existing one, so that a bad definition can never silently replace a good one.
45. As a pi user, I want a newly created definition to be delegable immediately in the same session, so that no restart or reload is needed.

## Implementation Decisions

**Form and distribution.** The extension is a standard extension directory with a package manifest and a single TypeScript entry point, loaded by Pi's `jiti`-based extension runtime without a build step. The layout is organized for later publication as a Pi package, but v1 ships as a loadable extension directory.

**Execution mechanism.** Each `task` invocation spawns a nested, in-process agent session via the Pi SDK's session factory, with an in-memory session manager (no session files) and shared model configuration/credentials from the host. *(Corrected during spec-graph import: since 0.1.10 the nested session writes a child session file when the host session persists — persistence follows the host; see `goal`, Principles.)* The nested session is disposed at the end of every task. Cancellation flows from the tool execution's abort signal into the nested session's abort. Progress is reported through the tool's update callback at coarse granularity (per turn), never as a stream.

**Agent definitions.** Definitions are Markdown files with YAML frontmatter in two resource directories: project-level (`.pi/agents/`, relative to the working directory) and user-level (`~/.pi/agent/agents/`). Frontmatter fields:

| Field | Meaning | Default |
|---|---|---|
| `name` | Canonical agent name | filename stem |
| `description` | One-line description used for delegation discovery | required |
| `tools` | Whitelist of tool names for the subagent | all default tools |
| `model` | Model identifier (Pi model id) | inherit host session's current model |
| `systemPrompt` | `replace` switches to body-only prompt | `append` (Pi default prompt + body) |

System prompt composition: by default the subagent receives Pi's complete default system prompt with the Markdown body appended as additional specialization instructions. `systemPrompt: replace` gives the body full ownership. The `task` tool is excluded from every subagent's tool set (no recursion in v1).

**Naming and conflict rules.** Project-level definitions override user-level definitions with the same name; the override is labeled in the `/subagents` listing. Malformed frontmatter and unknown model identifiers produce explicit, file-specific errors surfaced to the caller (tool error result or command notification) — never silent fallback.

**Trigger surfaces.** Three entry points: (1) the model-callable `task` tool, whose description is dynamically regenerated to enumerate all discovered agents (name + description) plus delegation guidance, kept in sync with definition changes; (2) `/subagents` listing and `/subagents <name>` detail; (3) `/subagents run <name> <task>` direct execution, whose output is shown to the user and excluded from model context by default, with a run option that instead sends the result into the model's context where the main agent can continue from it. All user entry points live under the single `/subagents` command.

**Isolation contract.** A subagent receives only the task text. No host conversation history, images, or session state cross the boundary. Task descriptions must be self-contained; making them so is the caller's responsibility. *(Corrected during spec-graph import: a subagent also inherits the project's context files — e.g. `AGENTS.md` — from the working directory; what never crosses is the host's private context: conversation, skills, prompt templates, themes, discovered extensions, Pi's docs. See `architecture`. Later amendment: skills gained a definition-level `skills` opt-in whitelist; `architecture` and `delegation-core` hold the current contract — this v1 record describes what shipped then.)*

**Result contract.** The `task` tool result contains the subagent's final reply text in model-facing content. Beyond 30,000 characters the content is truncated with an explicit notice and the complete result written to a temporary file (OS temp directory) whose path is included in the notice. Structured details carry turn count, token usage, model, task text, and duration, persisted with the tool result for later rendering. Nested usage is merged into the result's usage per Pi's nested-call convention so session totals remain accurate. Failures surface as error tool results carrying the underlying error text.

**Host-runtime conventions (follow Pi's documented extension contracts):** idempotent shutdown cleanup converging on one path across cancellation, reload, and session replacement; tool-call/tool-result handler composition semantics preserved; definition discovery hooked to resource discovery so files added or edited mid-session are picked up; behavior kept independent of rendering so non-interactive modes work.

## Testing Decisions

**What makes a good test.** Tests assert only external behavior visible at the host boundary: the content and structured details of `task` tool results, error result text, messages visible in the session, and command output. No test may reach into extension internals, private helpers, or in-memory bookkeeping. A refactor of the extension's internals must not require test changes.

**The seam.** One seam, at the highest point: the Pi SDK session factory boundary. Tests construct a complete agent session with everything in memory — in-memory session manager, in-memory settings, the subagents extension loaded, and a scripted fake model runtime (no network, no real model) that emits predetermined assistant turns and tool calls. All coverage — definition discovery and parsing, dynamic tool-description enumeration, isolation of subagent context, result truncation and on-disk persistence of full results, usage merging, broken-definition error reporting, and all `/subagents` subcommands — runs through this single seam by driving prompts, tool invocations, and commands and asserting on external results.

**Exception (default: do not add).** If error-path assertions for frontmatter parsing prove too convoluted through the scripted model, one additional pure seam — a definition-file-to-agent-descriptor parser function — may be added. Prefer shaping the fake model script to avoid this.

**Framework and prior art.** Vitest in a Node environment running the Pi SDK. The repository has no existing tests (greenfield); the Pi repository's SDK session examples are the reference shape for driving a full in-memory session programmatically. Tests must run offline and hermetically.

## Out of Scope

> Adopted into the spec graph with a correction: these are v1 scope limits, not current
> exclusions. Parallel dispatch, controlled recursion (opt-in, depth-bounded), and ad-hoc
> delegation have since shipped (`spec-v2`); nested-session transcripts are now saved as child
> sessions, with first-class resume/fork recorded as a non-goal in `goal`. The remaining items
> below were v1 decisions and still hold.

- Parallel dispatch of multiple subagents in one tool call.
- Recursive delegation (subagents spawning subagents); the `task` tool is withheld from subagents.
- Persistence, resumption, or forking of subagent sessions across runs.
- A separate permission/approval system for subagent tool calls; subagent calls follow existing host permission behavior.
- Streaming or live transcript rendering of subagent progress in the TUI (only coarse progress updates).
- Model-pool or cost-routing features (e.g. automatically assigning cheap models).
- Any GitHub / issue-tracker publishing workflow for this spec.
- Ad-hoc, definition-free delegation (inline prompt/tools per call); v1 always delegates to a named definition.

## Further Notes

- The `task` tool name matches the Claude Code convention deliberately, to give users zero learning cost.
- The delegation guidance injected into the `task` tool description is part of the product: without discovery and guidance, the main agent under-delegates and the plugin delivers no value.
- Direct-run via `/subagents run` is invoked by the user rather than the model; its results stay out of context by default, with an explicit run option to feed them back in.
- Truncation is a context-protection mechanism first and a storage mechanism second; the on-disk copy exists so nothing is lost.
- The v1 serial, one-level-deep design keeps the failure surface small; parallelism and recursion are pure increments on top of the same nested-session mechanism.
- Creation guidance is product behaviour, not convenience: before it existed, a live zero-definition run made the model hand-write definitions into the user-level directory (and reverse-engineer `PI_CODING_AGENT_DIR` after hitting a dead end). Deleting the dead end moves that decision into the plugin, where the project-first default is enforceable.
