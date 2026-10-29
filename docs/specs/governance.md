---
id: governance
type: module-design
status: draft
title: Governance — settings and consent
parent: architecture
depends-on: [definitions, dispatch]
---

# Governance — settings and consent

## Responsibility

Everything about what the extension is allowed to do without asking. Defaults
are the cautious choice.

**Settings** (`settings.ts`) — read from Pi's effective settings under the
`subagents` key, fresh on every use so a change applies without a reload.
Unknown or invalid values fall back to defaults rather than failing a
delegation (a boolean is accepted for `confirmProjectAgents` as a
convenience: `true` = ask, `false` = deny):

| Setting | Default | Meaning |
|---|---|---|
| `confirmProjectAgents` | `"ask"` | `"ask"` / `"allow"` / `"deny"`: consent before first use of a project-level agent |
| `allowModelCreatedDefinitions` | `true` | whether the model may author definitions via `create_subagent` |
| `allowUserScopeCreation` | `false` | whether definitions may be written to the user-level directory |
| `maxDepth` | `2` | delegation depth limit (top-level delegation is depth 1) |
| `defaultMaxTurns` | `50` | safety-net turn budget when neither definition nor call sets one (`0` = unlimited) |
| `defaultTimeoutMs` | `600000` | safety-net wall-clock budget in ms (`0` = unlimited) |

**Consent** (`authorizeAgents`) — repository-controlled prompts can instruct a
model to run commands, so the *first* use of a project-level definition in a
session is confirmed when a dialog UI exists. The answer is remembered per
agent per session; a remembered denial throws on a later attempt instead of
re-asking. Ad-hoc entries and user-level agents never ask (their prompts are
not repository-controlled — ad-hoc instructions are authored in-session and
follow the host's own permission behaviour). Without a dialog UI the rule is
explicitly divergent and deliberate: `"ask"` proceeds (automation never
hangs), `"deny"` throws naming the setting. This interactive/scripted
difference is the one behaviour that must stay written down.

**Gates**: `allowModelCreatedDefinitions` gates the whole `create_subagent`
tool; `allowUserScopeCreation` gates `scope: "user"` writes specifically.

## Boundary

- Policy only: never executes or formats a delegation. Depends on
  `definitions` (to tell a project-level definition from a user-level one)
  and, type-only, on `dispatch` (it takes the dispatch batch shape, so one
  confirmation flow covers single, fan-out, and chain entries uniformly — see
  `architecture` for that edge).
- The consent memory (the approvals map) and the settings snapshot live in the
  entry point; this module only consults them. Read by `task-surface`
  (enforcement point) and `command-surface` (gates, settings for direct runs).

## Known limitation

**Nested spawns bypass consent (recorded, accepted as-is).** The confirmation
check runs only in the top-level `task` tool; a controlled-recursion spawn
(the handler in `delegation-core`) calls `delegateTask` directly with no
check and no access to the session's approvals. A consented project agent
that opts into `allowSubagents` can therefore spawn *another* project-level
agent at depth 2 without a second confirmation. The observed behaviour is
recorded here as a known limitation, not as designed intent; fixing it is
separate work. *(Confirmed with the maintainer during graph import.)*
