---
id: definitions
type: module-design
status: draft
title: Definitions — discovery, parsing, validation
parent: architecture
---

# Definitions — discovery, parsing, validation

## Responsibility

Own everything about a definition *file*: its Markdown + frontmatter format,
discovery across the two resource directories, strict validation, and the
single create/validate path both creation surfaces go through.

- **Discovery** walks up from the working directory to the nearest directory
  containing `.pi/agents` (stopping at the filesystem root) and merges in the
  user-level directory (`~/.pi/agent/agents/`). Project wins a name collision
  and the override is labelled in listings. **Creation targets the directory
  discovery resolved** (creating `<cwd>/.pi/agents` when no ancestor has one)
  — discovery and creation never disagree.
- **Two validation regimes, deliberately.** Creation and edit-time are strict:
  an unknown tool name, an unresolvable model, an invalid budget, a
  `systemPrompt` value other than `replace`, an empty `tools:` or `skills:`
  list, `skills: all` mixed with concrete names, a duplicate name within one
  directory, or malformed frontmatter (e.g. an unterminated quote) is a loud,
  file-specific error — no silent fallback ever changes meaning. Discovery
  stays lenient about *availability*: a definition may legitimately name a
  tool a given session lacks or a skill that resolves nowhere, so a bad
  whitelist fails or degrades only the delegation that uses it, not the
  listing.
- **Budget and thinking parsing** (`limits.ts`) is shared policy: one notion
  of a valid positive-integer budget and one list of thinking levels (matching
  Pi's session levels), built on the `validate.ts` leaf. Each caller keeps its
  own failure policy — creation throws, settings fall back to a default — so
  this module never imports them back.
- **The format itself**: frontmatter accepts comma lists and YAML block
  lists; `name` defaults to the file stem; the Markdown body is the agent's
  instructions; the field set is `name`, `description`, `tools`, `model`,
  `systemPrompt`, `maxTurns`, `timeoutMs`, `maxTokens`, `thinking`,
  `allowSubagents`, `skills` (`all` or a name whitelist — the delegation
  side decides what that means for the nested session's skill index).
- The shared creation path validates *before* writing and refuses to replace
  an existing definition without an explicit flag; a definition written by
  either surface is delegable immediately in the same session.

## Boundary

- Depends on: `node:fs` / `node:path` and its own `validate` leaf. Never
  imports settings, never spawns or shapes a session, never renders text.
- Consumed by: `delegation-core` (target resolution), `governance`
  (project-source check), `task-surface` (inventory for the tool
  description), `command-surface` (listing and management), and the entry
  point.
- Writing definition *content* through creation and the edit round-trip goes
  through this module's parser; the command surface owns the edit/delete
  flows themselves and re-uses `parseAgentText` to decide whether a save is
  valid (an invalid edit is never written back).
