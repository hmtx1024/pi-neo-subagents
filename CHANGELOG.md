# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] — 2026-10-26

Correctness fixes from an architecture review of the 0.1.6 tree. All four
behaviour changes came out of reproducing the defect first; one accounting
field was corrected without a test because nothing observable reads it.

### Fixed

- **A failed delegation no longer leaves a ghost row in the live view.** The
  single-delegation path seeded its row and then skipped the cleanup when the
  delegation threw (unknown agent, unknown model, depth limit, cancellation),
  so `ghost · turn 0` stayed on screen until the next delegation.
- **`/subagents run` honours the configured depth limit.** The command path
  forwarded neither `subagents.maxDepth` nor the ledger hook, so a definition
  that opted into `allowSubagents` could never nest when started from the
  command — it always hit the depth limit — and direct runs were missing from
  `/subagents stats`. Both are forwarded now.
- **A chain drops each step from the live view as it settles.** `dispatchChain`
  never called `onSettled`, so completed steps accumulated while the next one
  ran. Every step (including skipped ones) settles now, and a chain seeds its
  first row at dispatch like the other shapes do.
- **The unprovidable-tool error no longer gives 0.1.5 advice.** It claimed a
  host extension tool arrives "only when the name is listed in tools", which
  0.1.6 made backwards; it now says the host session decides, the `task` tool
  bridges automatically, and `/subagents run` cannot.
- A failed run records the model its definition pinned instead of the host
  model. `/subagents stats` does not read the field yet — the record is simply
  truthful now.

### Measured

- Replayed the command path live: `/subagents run` on a `allowSubagents` lead
  nested a worker that wrote the expected file, with no depth error
  (2 turns, $0.000668) — the same call failed before the fix.
- 145 hermetic tests, `tsc` clean.

## [0.1.6] — 2026-10-26

Fixes from a real-usage session report: the natural ad-hoc entry shape now
works, host extension tools reach subagents by default, and the wall-clock
watchdog grows to ten minutes.

### Fixed

- **A task-only entry works.** `{ task }` alone now runs the job with a generic
  worker persona (`instructions` stays optional). Before, a model was bounced
  between "needs agent or instructions" and "task is required" — the observed
  session burned two host rounds learning the double-field shape the hard way.
- **Host extension tools reach subagents by default.** Omitting `tools` now
  grants built-ins *and* the host session's extension tools (search plugins,
  browsers, MCP-backed tools), running the host implementation with the host
  session's context. A `tools` list narrows strictly. In the observed session a
  research subagent lost its search plugin and degraded to scraping search
  engines with curl — slow, low-quality work that later tripped the time budget.
  `task` and `create_subagent` never cross, whitelist or not.
- **The `tools` schema descriptions no longer overpromise.** The 0.1.5 slimming
  had shortened them to "omit = all tools" while omitting granted built-ins
  only — actively wrong; a schema-honesty test keeps the wording truthful.
- **Default wall-clock watchdog: 5 → 10 minutes** (`subagents.defaultTimeoutMs`
  = 600000). Two real search-heavy subtasks were cut at exactly five minutes,
  mid-report.

### Changed

- The `task` description documents the task-only shape and the new bridging
  default; the "Host extension tools" README section (both languages) matches.

### Measured

- Replayed the failing scenario: the task-only fan-out succeeded on the first
  call (previously three attempts), and a no-`tools` delegation used the host's
  search tool automatically.
- 140 hermetic tests, live-model re-measures and the smoke suite all green.

## [0.1.5] — 2026-10-26

Token-efficiency release, driven by a measured baseline: the host's per-turn
tool payload and every subagent request got smaller. Delegation behaviour is
unchanged.

### Changed

- **Slimmer `task` and `create_subagent` schemas.** Field descriptions were
  rewritten to the bone (fields, shapes, and semantics untouched): the combined
  host-side surface dropped from 1,518 to ≤1,020 tokens (−33%) — and the host
  pays it on *every* turn. The guidance itself keeps every line v1/v2 live
  testing paid for: self-contained task descriptions, the three dispatch shapes
  with `{previous}`, the inline ad-hoc path, definition discovery/creation, and
  the extension-tool bridging rule — all locked by invariant tests.
- **Subagent system prompts drop Pi's documentation pointer.** The `docs` section
  (343 tokens, 62% of a subagent's system prompt) pointed at Pi's own docs —
  something an isolated subagent can never need. Nested prompts now run
  553 → 210 tokens; host sessions keep the section. If a task needs that
  knowledge, pass it in the task text (both READMEs document the trade-off).
- `task` description housekeeping: definition-directory paths on one line,
  redundant empty-inventory hint removed.

### Measured

- Host first-turn payload (input + cached): ≈7,130 → ≈6,700 per turn.
- Baseline and method: `profiling-report.md` in the repository's scratch notes;
  the overhead timer ships as `scripts/profile-overhead.mjs`.
- 132 hermetic tests, live-model re-measure and smoke suite verified the
  guidance did not regress (models still delegate correctly).

## [0.1.4] — 2026-10-26

Execution safety nets and host extension tools, both driven by real-usage
reporting.

### Added

- **Default execution budgets.** Every delegation now has a safety net when
  neither the definition nor the call sets one: `subagents.defaultMaxTurns`
  (50) and `subagents.defaultTimeoutMs` (5 minutes); set either to `0` to
  disable. A runaway model loop or a hung command now comes back cut short with
  the existing `Budget stop: …` notice (never an error) instead of blocking a
  fan-out forever. Explicit definition or per-call values always win.
- **Host extension tools bridge into subagents.** Naming an extension tool
  (a search plugin, a browser, an MCP-backed tool) in a delegation's `tools`
  exposes it to the subagent, running the host implementation with the host
  session's own dialogs and permissions. Whitelist-driven: no `tools` list, no
  bridging; `task` and `create_subagent` never cross.

### Fixed

- A definition could **promise a tool a subagent could never receive**:
  `create_subagent` validated tool names against the host tool map while
  nested sessions disable extensions outright, so the model hit
  `Tool X not found` at run time (for example with a search plugin installed).
  Whitelists the subagent cannot satisfy now fail the delegation naming the
  missing tools, and creation rejects `create_subagent` for subagents the same
  way it already rejected `task`.
- `/subagents run` fails loudly with the same message when a definition needs a
  bridged tool — command contexts cannot reach host tools, so it says so instead
  of silently dropping the tool.

### Changed

- The `task` tool description now states the bridging rule (extension tools
  cross only when named in `tools`).
- Documentation: both READMEs cover the default budgets and the "Host extension
  tools" section. The hermetic suite grew from 112 to 124 tests.

## [0.1.3] — 2026-10-25

Documentation only; no behaviour changes.

### Added

- `README.zh-CN.md`, a Simplified Chinese mirror of the README, with a language
  switcher at the top of both files. It now ships inside the package as well.

## [0.1.2] — 2026-10-25

Corrects the declared Node floor and adds continuous integration.

### Added

- GitHub Actions workflow: `npm ci`, typecheck, and the hermetic suite on Node 22
  and 24 across Linux and Windows, with a build-status badge in the README. The
  suite needs no credentials and costs nothing, because it drives in-memory
  sessions against a scripted fake model.

### Fixed

- `engines.node` claimed `>=20`, but the Pi host SDK requires `>=22.19.0`: on
  Node 20 every test file fails to load (`fs.globSync` does not exist there).
  The floor now matches the host.

## [0.1.1] — 2026-10-25

Packaging metadata only; no behaviour changes.

### Added

- `repository`, `homepage`, and `bugs` pointing at the source repository, so the
  npm page links to the code and to the issue tracker.

### Changed

- Development dependency `vitest` pinned to `^4`. Under `vitest` 5, a fresh
  clone could not install rolldown's optional native binding through
  `npm ci` ([npm/cli#4828]), which broke `npm test` on a clean checkout.
- `package-lock.json` regenerated at the same resolved versions.

[npm/cli#4828]: https://github.com/npm/cli/issues/4828

## [0.1.0] — 2026-10-24

First public release. Covers the v1 delegation core and the v2 governance work.

### Added — delegation core

- Named agent definitions as Markdown + frontmatter in `.pi/agents/` (project)
  and `~/.pi/agent/agents/` (user), with project-over-user precedence.
- `task` tool for the main agent: isolated nested sessions, self-contained task
  text only, final reply returned as the tool result.
- `/subagents` listing and detail views, and `/subagents run <name> [--to-context] <task>`
  for user-invoked delegation whose result stays out of the model's context by
  default.
- Definition enforcement: tool whitelists, model overrides, `systemPrompt: replace`.
- Result contract: 30,000-character truncation with the full result written to a
  temp file, structured details, merged usage, coarse progress updates.
- Non-interactive output routing: stdout in print mode, stderr in JSON mode,
  notifications in TUI and RPC.
- `create_subagent` tool and project-first placement, so a session with no
  definitions is never a dead end.

### Added — governance and scale (v2)

- Execution controls: `maxTurns`, `timeoutMs`, `maxTokens`, and `thinking` in a
  definition or per call; cut-short work is reported as a budget stop, never as
  a failure.
- Run ledger with `/subagents stats` and `stats reset`.
- Fan-out dispatch (`tasks`) with a configurable concurrency cap, submission
  order results, per-task status, and cancellation of everything in flight.
- Chained dispatch (`chain`) with `{previous}` substitution and stop-at-first-
  unfinished-step semantics.
- Ad-hoc delegation with inline `instructions`, no definition file, accounted as
  `ad-hoc`.
- Live TUI widget listing in-flight delegations with turn and current tool.
- Strict definition validation: non-`replace` `systemPrompt`, unknown tools,
  unresolvable models, and invalid budgets are errors.
- Discovery from nested working directories; listings show source file and
  modification time.
- Managed definitions: `/subagents new`, `edit`, `rm`.
- Authorization: project-level agents require first-use consent, plus settings
  `confirmProjectAgents`, `allowModelCreatedDefinitions`,
  `allowUserScopeCreation`, and `maxDepth`.
- Controlled recursion: opt-in `allowSubagents`, depth-bounded, with depth
  reported in results and the ledger.
- Hermetic test suite (112 tests) over a single session seam, plus an
  environment-gated live-model smoke suite (`npm run test:live`).

### Notes

- Delegation is serial per call unless `tasks` is used; nesting requires an
  explicit opt-in.
- `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are host-provided
  and declared as `peerDependencies` with a `*` range.
