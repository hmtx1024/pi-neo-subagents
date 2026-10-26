# pi-neo-subagents

[![CI](https://github.com/hmtx1024/pi-neo-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/hmtx1024/pi-neo-subagents/actions/workflows/ci.yml)

**English** · [简体中文](README.zh-CN.md)

Subagents for [Pi](https://github.com/earendil-works/pi): define named specialist
agents as Markdown files, then let the main agent delegate self-contained tasks
to them — or run them yourself. Each delegation runs in an isolated nested
session with its own conversation, so your main context stays small and focused.

```bash
pi install npm:pi-neo-subagents
```

- **Delegate**: a `task` tool the main agent calls, single / fan-out / chained,
  with per-run budgets and a run ledger.
- **Define**: Markdown definitions with tool whitelists, model overrides, and an
  opt-in for controlled recursion — project-first, reviewable in your repo.
- **Run**: `/subagents list|run|new|edit|rm|stats` for doing it yourself.

## Install

From npm:

```bash
pi install npm:pi-neo-subagents          # user-level
pi install npm:pi-neo-subagents -l       # project-level (needs project trust)
```

From a directory or a single file (TypeScript, no build step):

```bash
pi install /path/to/pi-neo-subagents
pi --extension /path/to/pi-neo-subagents/index.ts
```

Project-level installs land in `.pi/settings.json`, which Pi only honours after
project trust is granted — start Pi with `--approve` (or trust the project
interactively) or the package will appear to be ignored. It can also live under
`~/.pi/agent/extensions/` or `<project>/.pi/extensions/` for discovery.

To publish to npm, remove `"private": true` from `package.json` and add the
`pi-package` keyword; the `pi.extensions` manifest is already declared.

## Agent definitions

Definitions are Markdown files with YAML-style frontmatter in two resource
directories:

- project-level: `.pi/agents/*.md` (wins on a name collision, labelled in listings).
  Discovery walks up from the working directory to the nearest `.pi/agents`, so
  running Pi inside a subdirectory still finds the repository's agents.
- user-level: `~/.pi/agent/agents/*.md`

```markdown
---
description: Reviews code changes
tools: read, grep
model: anthropic/claude-sonnet-4-5
systemPrompt: replace
---

You are a careful code reviewer. Always cite the file you reviewed.
```

| Field | Meaning | Default |
|---|---|---|
| `name` | Canonical agent name | the file's stem |
| `description` | One-line description used for delegation discovery | required |
| `tools` | Whitelist of tool names for the subagent | all default tools |
| `model` | Model to run on (`provider/id` or bare id) | inherit the host session's model |
| `systemPrompt` | `replace` makes the body the entire system prompt | append to Pi's default prompt |
| `maxTurns` | Cap on assistant turns for one delegation | `subagents.defaultMaxTurns` (50) |
| `timeoutMs` | Wall-clock cap in milliseconds | `subagents.defaultTimeoutMs` (5 min) |
| `maxTokens` | Cap on total tokens for one delegation | unbounded |
| `thinking` | Thinking level (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) | inherit |
| `allowSubagents` | `true` lets this agent delegate further with the `task` tool | `false` |

Frontmatter accepts both `tools: read, grep` and YAML block lists:

```markdown
tools:
  - read
  - grep
```

Quoted values and trailing `# comments` are handled. Definition mistakes fail
loudly instead of silently changing behaviour:

- `tools:` present but empty → error (it used to mean "all default tools")
- an unterminated quoted value → error
- a `systemPrompt` value other than `replace` → error (omitting it still means append)
- at creation time: an unregistered tool name, an unresolvable model, an
  invalid budget, or the `task` tool (subagents never delegate further) → error
- two definitions with the same `name` in one directory → the later file is
  rejected with a duplicate-name error

The Markdown body is the agent's specialization instructions.

## Creating definitions

You can write definition files by hand, or let the agent do it. The
`create_subagent` tool takes `{ name, description, instructions, tools?, model?,
scope?, overwrite? }` and owns the file format and location:

- **`scope: "project"` (default)** → `<cwd>/.pi/agents/<name>.md`, so the
  definition travels with the repository and can be reviewed and committed.
- `scope: "user"` → `~/.pi/agent/agents/<name>.md`, only when explicitly asked.
- Existing definitions are never replaced unless `overwrite: true`; names that
  would escape the agents directory are rejected; the generated file is
  validated before it is written.
- A newly created definition is delegable immediately in the same session.

Asking for "one subagent reviews the pending diff, one scans the repo for TODOs"
in a project with no definitions therefore produces `reviewer.md` and
`scout.md` **inside the project**, not in your global config.

## Budgets

A delegation can be capped by turns, wall-clock time, and tokens — in the
definition, or per call (a per-call value wins):

```jsonc
// task tool call
{ "agent": "scout", "task": "…", "maxTurns": 3, "timeoutMs": 60000, "thinking": "low" }
```

Every delegation also has safety-net defaults, applied whenever neither the
definition nor the call sets a value: `subagents.defaultMaxTurns` (50) and
`subagents.defaultTimeoutMs` (5 min). Set either to `0` to disable that cap
everywhere; an explicit definition or per-call value always wins. This keeps a
runaway loop or a hung command from blocking a fan-out forever — the run comes
back cut short, never stuck.

Hitting a cap is a first-class outcome, not a failure: the subagent's reply so
far comes back with a note naming the budget that tripped, for example
`[Budget stop: turns limit 1 reached (observed 1). Partial reply above.]`.
Cut-short work stays distinguishable from a failed delegation, and the usage
footer still reports what it cost.

## Delegate from the main agent

The `task` tool lists every available agent in its description, names both
definition directories, and says project definitions are preferred. The main
agent delegates with a **self-contained** task description — the subagent sees the task
text only, never the host conversation. Its final reply comes back as the tool
result (oversized replies are truncated at 30,000 characters with the full
result written to a temp file).

### Fan-out

One call can dispatch several tasks concurrently:

```jsonc
{ "tasks": [
  { "agent": "reviewer", "task": "Review the diff of src/ for bugs" },
  { "agent": "scout",    "task": "Find every TODO under src/", "maxTurns": 4 }
] }
```

- Results come back **in submission order**, each as its own block with its
  status (`ok`, `budget stop (…)`, `failed`) and details.
- One failing task does not cancel its siblings; the call is an error only when
  every task failed.
- Concurrency is capped at 4 by default; set
  `PI_NEO_SUBAGENTS_MAX_CONCURRENCY=<n>` to change it.
- Cancelling the call cancels every in-flight task.
- A single `{ agent, task }` call behaves exactly as before.
- In the TUI, a widget lists every in-flight delegation with its current turn
  and tool, and clears when the dispatch settles. Other modes never show it.

### One-off work, without a definition

For work you will not reuse, an entry can carry inline instructions instead of an
agent name:

```jsonc
{ "instructions": "You read one file and summarize it in three bullets.",
  "tools": ["read"],
  "task": "Summarize docs/specs/subagents.md" }
```

- Nothing is written to disk and nothing appears in `/subagents`; the run is
  still counted in `/subagents stats` under the fixed label `ad-hoc`.
- Inline entries accept the same `model`, budget, and `tools` options as a
  definition, work in single, fan-out, and chain dispatch, and can never spawn
  further subagents.

### Host extension tools

A subagent never loads host extensions — that isolation is what keeps the
`task` tool from ever reaching a nested session. As a consequence, tools your
other extensions provide (search plugins, browsers, MCP-backed tools) are
absent by default.

Naming such a tool in `tools` **bridges** it: the subagent gets the tool, and
the call runs the host implementation with the host session's own context
(its dialogs and permissions included).

- Built-in tools never need bridging; they are available natively.
- Without a `tools` list nothing bridges — opting in is per delegation.
- `task` and `create_subagent` never cross, even when named.
- A list naming a tool the subagent cannot provide fails the delegation and
  names the tools; nothing is dropped silently.
- `/subagents run` cannot bridge (command contexts cannot reach host tools):
  a definition that needs a bridged tool fails there with the same message —
  delegate through the `task` tool instead.

### Controlled recursion

By default a subagent cannot delegate further. A definition can opt in:

```markdown
---
description: Plans work and delegates the parts
allowSubagents: true
tools: read, task
---
```

Opted-in agents receive the `task` tool in their nested session, and a depth
limit bounds the tree (`subagents.maxDepth`, default 2 — a top-level delegation
is depth 1). Exceeding it fails that call with the limit and the attempted
depth. Every result carries `details.depth`, and the ledger shows the deepest
level each agent ran at.

### Chains

Steps can run in order, each able to consume the previous reply — a
review-then-fix pipeline, for example:

```jsonc
{ "chain": [
  { "agent": "reviewer", "task": "Review src/runner.ts and list the problems" },
  { "agent": "fixer",    "task": "Fix exactly these problems, nothing else: {previous}" }
] }
```

- `{previous}` is replaced with the previous step's reply; using it in the first
  step is rejected before anything runs.
- A chain stops at the first step that fails **or is cut short by a budget**;
  remaining steps are reported as `skipped`, and the result names every step's
  status.
- A chain is strictly sequential, so the fan-out cap does not apply.

Delegation is one level deep by default: the `task` tool is never available to
subagents themselves. Nested sessions also load no extensions, skills, prompt
templates, or themes, so a subagent's prompt is its definition plus the task —
never the host's skill index.

## Run directly

```
/subagents                                          # list all definitions
/subagents <name>                                   # show one definition
/subagents run <name> <task>                        # run one; result shown to you only
/subagents run --to-context <name> <task>           # also send the result into the model's context
/subagents run "code review" <task>                 # quote names that contain spaces
/subagents run -- <name> <task>                     # anything after -- is taken literally
/subagents new <name> [description] [--force]       # scaffold a definition in the resolved project dir
/subagents edit <name>                              # open the resolved file; invalid edits are not saved
/subagents rm <name> [--yes]                        # delete after confirmation (--yes for scripts)
/subagents stats                                    # per-agent runs, turns, tokens, cost, average time
/subagents stats reset                              # clear this session's ledger
```

The ledger is per session and accounts for every delegation — single, fan-out,
and chain steps — counting successes, failures, and budget stops separately:

```
Delegation ledger (this session):
- reviewer: 1 run (1 ok, 0 failed, 0 budget stops) · 3 turns · tokens 647 in / 410 out · $0.000718 · avg 4616ms
- scout: 1 run (1 ok, 0 failed, 0 budget stops) · 2 turns · tokens 421 in / 221 out · $0.000411 · avg 2475ms
Total: 2 runs · $0.001130
```

Options are parsed only before the name, so `--to-context` inside a task stays
part of the task text. Unknown options are rejected with the usage line.

Direct runs report a one-line usage summary (model, turns, tokens, cost). Long
results are shortened for display and the full text is written to a temp file
named in the notice.

### Output channels

| Mode | Where command output goes |
|---|---|
| TUI | notification |
| RPC | `extension_ui_request` notification |
| `--print` | stdout |
| `--mode json` | stderr (stdout is the JSON event stream) |

Progress for a long direct run appears as a status line (`<agent> · turn N`) and
is cleared when the run finishes.

## Windows / Git Bash

MSYS rewrites arguments that start with `/`, so passing a slash command on the
command line (`pi -p "/subagents"`) reaches Pi as
`D:/Program Files/Git/subagents`. Quote it differently or disable the rewrite for
that argument:

```bash
MSYS2_ARG_CONV_EXCL='/subagents' pi -p "/subagents"
pi -p "//subagents"          # MSYS strips one slash
```

This does not affect typing commands inside the Pi TUI, RPC clients, cmd.exe, or
PowerShell.

## Settings

Optional settings live under the `subagents` key of Pi's settings (global
`~/.pi/agent/settings.json` or project `.pi/settings.json`):

```json
{
  "subagents": {
    "confirmProjectAgents": "ask",
    "allowModelCreatedDefinitions": true,
    "allowUserScopeCreation": false,
    "maxDepth": 2,
    "defaultMaxTurns": 50,
    "defaultTimeoutMs": 300000
  }
}
```

| Setting | Meaning | Default |
|---|---|---|
| `confirmProjectAgents` | `"ask"`, `"allow"`, or `"deny"`: whether a project-level agent needs consent before its first use in a session | `"ask"` |
| `allowModelCreatedDefinitions` | whether the model may author definitions with `create_subagent` | `true` |
| `allowUserScopeCreation` | whether definitions may be written to the user-level directory | `false` |
| `maxDepth` | delegation depth limit (reserved for controlled recursion) | `2` |
| `defaultMaxTurns` | safety-net turn budget when neither the definition nor the call sets one (`0` = unlimited) | `50` |
| `defaultTimeoutMs` | safety-net wall-clock budget in milliseconds (`0` = unlimited) | `300000` |

Consent is remembered per agent for the session, and a denial runs nothing.
User-level agents and ad-hoc entries never prompt. In a session without a
dialog UI, `"ask"` proceeds (automation never hangs) while `"deny"` refuses.

## Development

Requires Node 22.19 or newer — the floor declared by the Pi host SDK.

```bash
npm ci          # installs from the committed lockfile
npm test        # vitest, hermetic: scripted fake model, no network
npm run typecheck
npm run test:live   # live-model smoke suite (real provider, real cost)
```

`npm test` is offline and never needs credentials. The live suite is excluded
from it and runs only through `npm run test:live`, which enables it with
`PI_NEO_SUBAGENTS_LIVE=1`:

- It uses the credentials Pi already has, so run `pi auth` first if needed.
- `PI_NEO_SUBAGENTS_LIVE_MODEL=provider/model` picks the model (default
  `deepseek/deepseek-flash`).
- A missing model or provider fails loudly with instructions instead of
  skipping, so a green run always means the real path worked.
- A full run costs roughly 25 seconds and a few thousand tokens: it creates two
  definitions in a temp project, fans out to them, checks the files and the
  ledger, and delegates one ad-hoc task to prove no definition is created.

Tests drive full in-memory agent sessions through the Pi SDK with pi-ai's
`fauxProvider` as the scripted model; behaviour is asserted only at the
session boundary (tool results, visible messages, recorded UI output).

Repository layout:

| Path | Contents |
|---|---|
| `index.ts`, `src/` | the extension itself — everything that ships to npm |
| `test/` | hermetic suite; `test/live/` is the opt-in live suite |
| `docs/specs/` | behaviour specifications, current and superseded |
| `docs/history/` | design records: the tickets each version came from, and the real-model test report |
| `scripts/manual-test/` | RPC driver and fixtures for scripted end-to-end runs against a real `pi` process |
| `RELEASING.md` | how a version is cut, verified, and published |
