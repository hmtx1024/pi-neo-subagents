# 12: Live-model smoke suite

**What to build:** An environment-gated suite runs the real path against a cheap real model — no definitions, create two, delegate in parallel, delegate ad-hoc — asserting the files, results, and ledger a user would see. It is excluded from the default test command, so normal development stays offline, and it exists because the hermetic suite passed 42 tests while eight real defects shipped.

**Blocked by:** 03 (parallel dispatch), 05 (ad-hoc delegation), 09 (managed definitions)

**Spec:** `docs/specs/subagents-v2.md`

**Status:** done

- [x] The suite runs only when its environment variable is set and is skipped otherwise
- [x] It is excluded from the default test command
- [x] It covers zero definitions → create two definitions → parallel delegation → verify definitions landed in the project directory
- [x] It verifies delegation results are real replies and that the ledger recorded the runs
- [x] It covers one ad-hoc delegation and asserts no definition file was created
- [x] Missing credentials or model configuration fail loudly with instructions, never silently skip
- [x] The README documents how to run it and what it costs

## Notes

- The suite lives in `test/live/` and has its own config (`vitest.live.config.ts`); the default config excludes that directory entirely, so `npm test` never runs it and never needs credentials.
- `npm run test:live` spawns the local vitest binary with `PI_NEO_SUBAGENTS_LIVE=1` — no shell, no platform-specific env syntax. `PI_NEO_SUBAGENTS_LIVE_MODEL` overrides the model (default `deepseek/deepseek-flash`).
- Credentials come from Pi's real agent directory, exactly as the CLI uses them. A missing model or provider fails with instructions (run `pi auth`, pick a model) instead of skipping — a green run must mean "the path works", never "nothing happened".
- Two scenarios cover the two ways a user reaches delegation: the zero-definition path (create two definitions, fan out, verify files and ledger) and the ad-hoc path (no definition file created, accounted as `ad-hoc`).
- Measured cost of a full run: about 25 seconds and a few thousand tokens on the default model.
- Observed value: this suite is the reason the remaining v2 gaps were found cheaply rather than in use — it exercises the real guidance, the real tool shapes, and the real filesystem.
