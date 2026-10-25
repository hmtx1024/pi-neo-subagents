import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// The live-model smoke suite costs money and needs credentials; it has its
		// own config and is never part of the default run.
		exclude: [...configDefaults.exclude, "test/live/**"],
		// PI_CODING_AGENT_DIR is process-global; serialize tests.
		fileParallelism: false,
		// Sessions talk to an in-process fake model; generous timeout for slow CI.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
