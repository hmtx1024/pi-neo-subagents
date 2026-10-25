# 09: Managed definitions — `/subagents new`, `edit`, `rm`

**What to build:** The user gets the same power over definitions that `create_subagent` gives the model: scaffold a correct definition, open one for editing, and delete one after confirmation — all through one creation and validation path, placed where discovery will find it.

**Blocked by:** 07 (creation validation), 08 (discovery and placement)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] `/subagents new` writes a valid definition into the resolved project directory
- [x] `/subagents new` prompts for missing name and description, and refuses to write an invalid combination
- [x] `/subagents new` refuses to overwrite an existing definition unless explicitly asked
- [x] `/subagents edit <name>` resolves the definition through discovery and opens its file
- [x] `/subagents edit` on an unknown name reports the available names
- [x] `/subagents rm <name>` asks for confirmation and deletes only a definition resolved through discovery
- [x] `/subagents rm` without confirmation, or for an unknown name, changes nothing
- [x] Creation from the command and from `create_subagent` share one code path, so validation cannot drift between them
- [x] Command output respects the existing non-interactive output contract

## Notes

- `new` writes through the same `createAgentDefinition` path as `create_subagent` (same validation, same placement), so the two can never drift. The scaffolded body is a one-line stub, and the command tells the user to run `edit`.
- Dialogs are used only when `hasUI` is true. Without a UI, `new` prints usage, `edit` explains that editing needs a terminal, and `rm` requires `--yes` — nothing blocks waiting for an answer.
- `edit` validates the edited text with the same parser discovery uses; an invalid edit is reported and the file keeps its last good content.
- `edit` and `rm` resolve the definition through discovery and delete/edit exactly the file discovery reported, including user-level definitions and definitions found in an ancestor directory.
- Live check: `new` created a definition in the resolved project directory, the detail view showed it, and `rm --yes` removed it.
