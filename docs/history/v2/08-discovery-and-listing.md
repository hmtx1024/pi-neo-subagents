# 08: Discovery and listing fidelity

**What to build:** Running Pi anywhere inside a repository finds that repository's agent definitions by walking up to the nearest `.pi/agents`, and definitions created by the model land in exactly the directory discovery uses. `/subagents` shows, for each definition, the file it came from and when it was last modified.

**Blocked by:** None (can start immediately)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] Project discovery walks up from the working directory and uses the nearest directory containing agent definitions
- [x] The walk stops at the filesystem root and never loops
- [x] With no ancestor definition directory, discovery falls back to the working directory's own directory
- [x] Creation targets the same directory discovery resolved, and creates one under the working directory only when no ancestor has one
- [x] `/subagents` lists the source file for each definition
- [x] `/subagents` lists the modification time for each definition
- [x] Project-over-user override labelling and duplicate-name reporting keep working

## Notes

- Discovery walks up from the working directory to the nearest existing `.pi/agents`, stopping at the filesystem root; with no ancestor it falls back to the working directory. Creation calls the same resolver, so placement and discovery cannot disagree.
- Listing rows append `project: <file> · <mtime>` (or `user: …`), keeping the existing tool/model fields and the override label. Timestamps are UTC and locale-independent so output is stable in tests and logs.
- The detail view gains a `File:` line with the same information.
- Live check: from `repo/packages/deep`, `/subagents` listed the repository's agents with their files and modification times.
