# 01: Scaffold: extension skeleton + hermetic test seam

**What to build:** The subagents extension loads into a Pi session as a standard extension directory with a single TypeScript entry point and no build step. The project owns a hermetic end-to-end test seam: a full in-memory agent session (in-memory session manager and settings, scripted fake model, no network) with the extension loaded. A smoke test proves the seam by exercising one trivial registered capability and asserting only behavior visible at the session boundary. This ticket makes every later change easy: all subsequent tickets land their tests through this seam.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] The extension directory with its package manifest loads in Pi with no build step
- [x] The extension factory registers at least one trivial capability (command or tool) visible to a session
- [x] Vitest runs offline against a full in-memory session with a scripted fake model and the extension loaded
- [x] The smoke test asserts external behavior only (tool results / visible messages at the session boundary) and passes
- [x] Tests are hermetic: no network access, no real model calls, no session files left behind
