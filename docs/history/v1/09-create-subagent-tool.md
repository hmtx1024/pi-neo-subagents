# 09: `create_subagent` — project-first definition creation

**What to build:** When no existing definition fits, the main agent must be able to create one in a single tool call, and that definition must land in the **project** directory by default. The `task` tool description must name both definition directories, the project-first preference, and the serial nature of delegation, so a zero-definition session is never a dead end that tempts the model into hand-writing files in the global user directory.

**Why:** a live zero-definition run (see `.scratch/pi-neo-subagents/manual-test-report.md` and the follow-up experiment) showed the model hitting `No agent definitions found.`, then hand-writing two definitions into `<agentDir>/agents/` and reverse-engineering `PI_CODING_AGENT_DIR` to make them resolve. Placement was wrong (global, not reviewable in the repo) and the flow depended on the model guessing the file format correctly.

**Blocked by:** nothing (follow-up to 01–08)

**Status:** done

## Behaviour

- [x] `create_subagent` tool: `{ name, description, instructions, tools?, model?, scope?, overwrite? }`
- [x] Default scope is `project` → `<cwd>/.pi/agents/<slug>.md`; `scope: "user"` explicitly targets `<agentDir>/agents/`
- [x] Names containing path separators (or `.` / `..`) are rejected; the canonical name is written into frontmatter so the file name can be a slug
- [x] The generated definition is validated with the same parser as discovery before it is written; invalid input fails with a clear error
- [x] An existing definition (same file or same name) is never overwritten unless `overwrite: true`
- [x] A created definition is delegable immediately in the same session (delegation re-discovers on every call)
- [x] The tool result reports the path, the scope, immediate availability, and warns when a user-level definition of the same name is shadowed
- [x] `task` tool description names both directories, states that project scope is preferred, points at `create_subagent` when nothing fits, and says delegations run one at a time
- [x] Empty inventory message: `No agent definitions found. Create one with create_subagent, or add <cwd>/.pi/agents/<name>.md.`

## Acceptance

- [x] `test/create-subagent.test.ts` — project-first creation + immediate delegation, explicit user scope, no overwrite, path-escaping names rejected, description guidance
- [x] `npx vitest run` — 47 tests across 13 files, all passing
- [x] `npx tsc --noEmit` clean
- [x] Live re-verification: a zero-definition prompt delegates via a model-created **project** definition
- [x] README documents creation, scopes, and the project-first default
