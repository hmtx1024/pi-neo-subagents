# 04: Result contract: truncation + disk copy + details + usage merge + progress

**What to build:** Delegation results honour the context-protection contract. A result beyond 30,000 characters is truncated in the tool result content with an explicit notice pointing to the complete result written to a temporary file on disk. Structured details — turn count, token usage, model, task text, duration — travel with the tool result and persist with it. Nested token usage is merged into session usage totals so accounting stays accurate. While a subagent runs, the caller sees coarse progress updates (e.g. current turn count) instead of a silent hang.

**Blocked by:** 03

**Status:** ready-for-agent

- [x] Results over 30,000 characters are truncated with a notice naming the on-disk location of the complete result
- [x] The complete result actually exists at the referenced path and is byte-identical to the subagent's full reply
- [x] Results under the limit pass through untruncated (covered by the exact-equality delegation tests)
- [x] Structured details (turn count, token usage, model, task, duration) persist with the tool result
- [x] Nested token usage is merged into the session's usage totals (via the tool result's `usage` field, pi's documented merge channel)
- [x] Coarse progress updates are emitted while a subagent executes
