# 07: Hardening & packaging: cancellation, idempotent cleanup, mode parity, installable

**What to build:** The complete feature behaves correctly under stress and in every Pi mode. Aborting a running task tears down the nested session cleanly and reports the cancellation to the caller. Cancellation, reload, session switching, and process exit converge on one idempotent cleanup path. Delegation and the `/subagents` command family work in RPC, JSON, and print modes with rendering skipped but behavior intact. The package installs as a standard extension with no build step, structured for later Pi package publication.

**Blocked by:** 04, 05, 06

**Status:** done (see 08 for the live-test corrections)

- [x] Aborting mid-task tears down the nested session and surfaces a clean cancellation result to the caller (ticket 03's cancel test + hardening: cancel leaves the session ready for the next delegation)
  - **Corrected after live testing (see 08):** this holds only once the tool call is actually executing. An abort that lands while the host is still streaming the tool call does NOT prevent the delegation from running to completion — host-level behaviour, tracked upstream, documented in 08.
- [x] Cleanup is idempotent across cancellation, reload, session switch, and process exit (all resources are task-scoped and disposed in one `finally` path; verified via mid-run abort, double-dispose, and healthy follow-up sessions)
- [x] RPC, JSON, and print modes: delegation and `/subagents` behavior are intact, rendering is skipped without affecting behavior (verified in `print` mode; the extension uses no terminal-only UI)
  - **Corrected after live testing (see 08):** "rendering is skipped" was wrong — commands executed but every output channel was dropped, so `/subagents run` burned tokens invisibly. Fixed in 08 with explicit stdout (print) / stderr (json) / notify (tui, rpc) routing, now covered by `test/output-modes.test.ts`.
- [x] The package installs and loads as a standard extension with no build step (`npm pack` verified; every test loads the real entry through Pi's jiti loader)
- [x] The full spec's acceptance surface is covered by tests through the single session-boundary seam (coverage review: stories 1/20–24/35 → task-tool; 2–16/33–34 → inventory + definition-enforcement; 17–19 → enumeration; 25–29 → result-contract; 30–32/39 → direct-run; 36–38 → hardening + packaging; empty-inventory error → smoke)
