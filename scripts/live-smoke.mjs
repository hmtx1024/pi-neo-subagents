/**
 * Run the live-model smoke suite with its enabling variable set.
 *
 * Usage: npm run test:live
 * Optional: PI_NEO_SUBAGENTS_LIVE_MODEL=provider/model (default deepseek/deepseek-flash)
 *
 * Spawns the local vitest binary directly: no shell, no argument quoting issues,
 * and the suite still receives the enabling variable.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const child = spawn(process.execPath, [vitest, "run", "--config", "vitest.live.config.ts"], {
	stdio: "inherit",
	env: { ...process.env, PI_NEO_SUBAGENTS_LIVE: "1" },
});
child.on("exit", (code) => process.exit(code ?? 1));
