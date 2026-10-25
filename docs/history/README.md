# Development history

Design records kept with the project so the reasoning behind the current code
stays readable next to it. Nothing here is needed to use, install, or build the
package — [the README](../../README.md) and [the specs](../specs) are the entry
points.

| Path | What it is |
|---|---|
| `v1/` | Tickets for the original delegation core (scaffold, discovery, `task` tool, result contract, definition enforcement, direct run, hardening, live-test fixes, `create_subagent`). |
| `v2/` | Tickets for the governance and scale work (budgets, ledger, fan-out, chains, ad-hoc, strict validation, discovery/listing, managed definitions, authorization, controlled recursion, TUI view, live smoke suite). |
| `manual-test-report.md` | Findings from driving a real `pi` process against real models, plus the status of every fix it produced. |

Each ticket states the user stories it came from, the behaviour it promised, the
seam it tested through, and its acceptance criteria — so it doubles as the "why"
for the code that implements it. The matching specs live in [`docs/specs/`](../specs).

Predecessor and superseded tickets are kept as-is; they describe what was true
when they were written, not what is true today.

## Where the current work lives

Active scratch notes, logs, and throwaway probes stay in `.scratch/` at the
repository root and are intentionally untracked. Durable artefacts get promoted
here (design records) or into [`scripts/manual-test/`](../../scripts/manual-test)
(reproducible fixtures and the RPC driver).

## Manual-testing kit

`scripts/manual-test/rpc-drive.mjs` is a JSONL client for `pi --mode rpc` that
answers confirmations automatically, so a scenario can be scripted as a list of
instructions. Its fixtures are three ready-made working directories under
`scripts/manual-test/fixtures/`:

```bash
cd scripts/manual-test/fixtures/project      # 12 definitions: normal, duplicate, broken YAML, CJK names
cd scripts/manual-test/fixtures/broken       # definitions that must be rejected (bad model, no description, recursion)
cd "scripts/manual-test/fixtures/中文 目录"   # non-ASCII directory and agent name

# drive a scenario (needs real provider credentials)
RPC_CWD=$PWD RPC_MODEL=deepseek/deepseek-flash node ../../rpc-drive.mjs '["/subagents"]'
```

The reports these runs produced are summarised in `manual-test-report.md`; the
raw logs were not kept.
