# 02: Agent inventory: definition discovery/parsing + `/subagents` list & detail

**What to build:** Users place Markdown agent definitions — YAML frontmatter (`name`, `description`, `tools`, `model`, `systemPrompt`) plus a Markdown body — in a project-level resource directory and a user-level resource directory. `/subagents` lists every discovered agent with its name, description, tools, and model, and marks definitions where the project-level one overrides a user-level one. `/subagents <name>` shows one agent's full definition. A definition with malformed frontmatter is reported as a clear, file-specific error instead of showing up as a silently broken agent. The author-facing naming and conflict rules from the spec are in force: `name` defaults to the filename stem, project-level wins on collision.

**Blocked by:** 01

**Status:** ready-for-agent

- [x] Definitions are discovered from both the project-level and user-level resource directories
- [x] All frontmatter fields are parsed; `name` defaults to the file's stem when omitted
- [x] On a name collision, the project-level definition overrides the user-level one and the listing labels the override
- [x] `/subagents` lists name, description, tools, and model for every discovered agent
- [x] `/subagents <name>` displays the full definition of one agent
- [x] Malformed frontmatter yields a file-specific error message; nothing falls back silently
