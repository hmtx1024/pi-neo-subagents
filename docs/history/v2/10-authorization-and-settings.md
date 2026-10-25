# 10: Authorization and settings

**What to build:** Using a project-level agent (which can instruct a model to run commands) requires consent the first time in a session, and the model cannot author definitions unless allowed. Four settings control this: project-agent confirmation, model-created definitions, user-scope creation, and maximum depth. Non-interactive modes never hang waiting for an answer.

**Blocked by:** 03 (the confirmation must cover every dispatch shape the feature offers), 05 (ad-hoc entries must be exempt)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] The first use of a project-level agent in a session prompts for confirmation
- [x] The answer is remembered per agent for the rest of the session, so only the first use prompts
- [x] Denying the confirmation fails that delegation with a clear message and runs nothing
- [x] User-level agents never prompt
- [x] Ad-hoc entries never prompt
- [x] Settings exist for project-agent confirmation, model-created definitions, user-scope creation, and maximum depth
- [x] With model-created definitions disabled, `create_subagent` refuses and explains the setting
- [x] With user-scope creation disabled, a user-scope creation request is refused
- [x] In modes without a dialog UI, behaviour follows the setting and never blocks waiting for input
- [x] Confirmation state does not leak across sessions

## Notes

- Settings live under the `subagents` key of Pi's effective settings (global or project): `confirmProjectAgents`, `allowModelCreatedDefinitions`, `allowUserScopeCreation`, `maxDepth`. They are read fresh on each use, so a settings change applies without a reload. Invalid values fall back to defaults instead of failing a delegation.
- `confirmProjectAgents` is a tri-state: `"ask"` (default), `"allow"`, `"deny"`. A boolean is accepted for convenience (`true` → ask, `false` → deny). `"ask"` without a UI proceeds — automation must never block — while `"deny"` without a UI refuses with a message naming the setting.
- Consent is remembered per project agent for the session (including denials). Authorisation is checked before anything runs, so a denial means nothing executes; the error names the agent.
- User-level agents and ad-hoc entries never prompt: one is the user's own configuration, the other was authored by the model in this very call.
- Confirmation is requested with the definition's file path and the reason (project prompts can instruct the model to run commands), which is what the live check confirmed.
- Both tool-side gates are additive to ticket 07's validation: a disabled creation path is refused before any file is written.
