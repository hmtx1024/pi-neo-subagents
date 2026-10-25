# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
