import { defineConfig } from "vitest/config";

/**
 * Live-model smoke suite: real providers, real money, real latency.
 * Run it with `npm run test:live` (which sets the enabling variable).
 */
export default defineConfig({
	test: {
		include: ["test/live/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 120_000,
	},
});
