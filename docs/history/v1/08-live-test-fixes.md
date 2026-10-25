# 08: Live-test hardening — silent failures, argument parsing, output channels

**What to build:** Fix the defects found while running the real extension against real models (`.scratch/pi-neo-subagents/manual-test-report.md`). Priority order there was: silent safety downgrades (B3), silent token spend (E2), tasks rewritten by option parsing (B2), then contract/UX items (B5, B6, B7, B4, B8, B10). Packaging and platform notes land in docs.

**Blocked by:** nothing (follow-up to 01–07)

**Status:** done

## Fixed

- [x] **B3 — `tools:` silently widened to "all default tools".** Frontmatter parsing now understands YAML block lists (`tools:` + `- read`), quotes, and trailing `# comments`; a present-but-empty `tools`, an unterminated quoted value, and other malformed lines are file-level errors instead of silent fallbacks. `test/definition-parsing.test.ts`
- [x] **E2 — non-interactive modes dropped all command output.** `/subagents` and `/subagents run` now write to stdout in `--print` mode, to stderr in `--mode json` (stdout stays a clean JSON stream), and to `notify` in TUI/RPC. `test/output-modes.test.ts`
- [x] **B2 — `--to-context` anywhere in the task was stripped.** Options are parsed only before the agent name; `--` ends option parsing; unknown options fail with the usage line. The task text is never rewritten. `test/run-parsing.test.ts`
- [x] **B5 — duplicate names listed twice and delegated unpredictably.** A duplicate `name` within one directory rejects the later file with a duplicate-name error naming the original; the listing shows one entry. `test/definition-parsing.test.ts`
- [x] **B4 — agent names containing spaces were listed but unusable.** `/subagents run "code review" <task>` now accepts a quoted name. `test/run-parsing.test.ts`
- [x] **B6 — direct runs reported no usage and no progress.** Direct runs print a usage footer (model, turns, tokens in/out, cost) and publish `<agent> · turn N` via `setStatus`, cleared on completion. `test/output-modes.test.ts`
- [x] **B7 — a long direct-run result flooded the notification.** Display is capped at 2,000 characters with a notice naming a temp file that holds the complete result. `test/output-modes.test.ts`
- [x] **B8 — subagent prompts carried the host skill index.** Nested sessions now load no skills, prompt templates, or themes (extensions were already disabled), so a subagent's prompt is its definition plus the task. `test/skill-isolation.test.ts`
- [x] **B10 — inconsistent wording and unhelpful unknown-agent errors.** Empty-inventory wording is shared, and unknown names now come with the available agent list. `test/errors.test.ts`

## Fixed as packaging/docs

- [x] **E4 — package manifest.** Added an explicit `pi.extensions` manifest; moved the host-provided `@earendil-works/pi-*` packages from `dependencies` to `peerDependencies: "*"` (Pi warns otherwise: duplicate runtime modules), keeping them in `devDependencies` for local tests. Publishing still needs `private: true` removed plus the `pi-package` keyword — documented in the README.
- [x] **E1 — Git Bash `/subagents` path rewriting.** Documented with working escapes (`//subagents`, `MSYS2_ARG_CONV_EXCL`); no code change possible or needed.
- [x] **E3 — project-level `pi install -l` needs trust.** Documented (`--approve`).
- [x] **B9 — a model may recite a stale agent list after a deletion.** Request-level refresh is covered by tests; recorded as model behaviour, no code change.

## Reclassified (not defects)

- [x] **B11 — `--to-context` reports `disposition: "handled"` while a run starts.** Documented by Pi: `handled` describes the submitted prompt, "not independent work started by an extension". Commands are expected to drive their own LLM interaction. Report corrected.
- [x] **B1 — cancel race.** The plugin honours the abort signal it is given and the nested session tears down; an abort arriving before the host starts the tool call is host-side behaviour. Reported, not patched here.

## Acceptance

- [x] `npx vitest run` — 42 tests across 12 files, all passing
- [x] `npx tsc --noEmit` clean
- [x] Live re-verification against a real model: print-mode listing and direct run print to stdout (with usage footer), JSON mode keeps stdout a clean protocol stream, no packaging warning on load
