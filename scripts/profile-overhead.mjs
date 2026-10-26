/**
 * Profiling track 1 — fixed overhead per delegation (hermetic, repeatable).
 *
 * Times the pieces a single `task` delegation pays before the model is even
 * asked anything: ModelRuntime creation, resource loader construction+reload,
 * and session assembly — plus a full ×3 fan-out round (today each nested run
 * repeats all of it). Uses the scripted faux provider: no network, no cost.
 *
 * Run: node scripts/profile-overhead.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const ITERATIONS = Number(process.env.PROFILE_ITERATIONS ?? 9);
const NESTED = ["read", "bash", "edit", "write"];

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

function makeDirs() {
	// PROFILE_CWD / PROFILE_AGENT_COUNT simulate a real project: a real working
	// directory and a populated agents dir exercise the loader's discovery path.
	const cwd = process.env.PROFILE_CWD ? process.env.PROFILE_CWD : mkdtempSync(join(tmpdir(), "profile-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "profile-agent-"));
	const count = Number(process.env.PROFILE_AGENT_COUNT ?? 0);
	if (count > 0) {
		const agents = join(agentDir, "agents");
		mkdirSync(agents, { recursive: true });
		for (let i = 0; i < count; i += 1) {
			writeFileSync(
				join(agents, `agent-${i}.md`),
				`---
description: Agent number ${i} for loader scaling
tools: read, bash
---

You are agent ${i}.
`,
			);
		}
	}
	return { cwd, agentDir, ephemeralCwd: !process.env.PROFILE_CWD };
}

/** Exactly what src/runner.ts does for every nested run today. */
async function fullSetup(dirs) {
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
	modelRuntime.registerNativeProvider(faux.provider);

	const resourceLoader = new DefaultResourceLoader({
		cwd: dirs.cwd,
		agentDir: dirs.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPromptOverride: (base) => [...base, "You are a test subagent."],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: dirs.cwd,
		agentDir: dirs.agentDir,
		modelRuntime,
		model: faux.getModel(),
		sessionManager: SessionManager.inMemory(dirs.cwd),
		resourceLoader,
		tools: NESTED,
	});
	return { modelRuntime, session, faux };
}

async function timeSetupParts() {
	const dirs = makeDirs();
	try {
		// (1) ModelRuntime.create alone
		const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });

		// (2) loader construction + reload alone
		const loader = new DefaultResourceLoader({
			cwd: dirs.cwd,
			agentDir: dirs.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			appendSystemPromptOverride: (base) => [...base, "You are a test subagent."],
		});
		const t0 = performance.now();
		await loader.reload();
		const reloadMs = performance.now() - t0;

		return { runtimeMs: undefined, reloadMs, runtime };
	} finally {
		// dirs cleaned by caller
	}
}

async function main() {
	const results = { setupMs: [], reloadMs: [], sessionMs: [], e2eMs: [], fanout3Ms: [], totalPhaseMs: [] };
	const dirsList = [];

	for (let i = 0; i < ITERATIONS; i += 1) {
		const dirs = makeDirs();
		dirsList.push(dirs);

		// Full setup, timed by phase
		const tAll = performance.now();

		const t0 = performance.now();
		const modelRuntime = await ModelRuntime.create({
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
		modelRuntime.registerNativeProvider(faux.provider);
		const runtimeMs = performance.now() - t0;

		const t1 = performance.now();
		const resourceLoader = new DefaultResourceLoader({
			cwd: dirs.cwd,
			agentDir: dirs.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			appendSystemPromptOverride: (base) => [...base, "You are a test subagent."],
		});
		await resourceLoader.reload();
		const reloadMs = performance.now() - t1;

		const t2 = performance.now();
		const { session } = await createAgentSession({
			cwd: dirs.cwd,
			agentDir: dirs.agentDir,
			modelRuntime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(dirs.cwd),
			resourceLoader,
			tools: NESTED,
		});
		const sessionMs = performance.now() - t2;

		// End-to-end: prompt the nested session once (faux replies instantly)
		faux.setResponses([fauxAssistantMessage("done")]);
		const t3 = performance.now();
		await session.prompt("Do the thing.");
		const e2eMs = performance.now() - t3;
		session.dispose();

		results.setupMs.push(runtimeMs);
		results.reloadMs.push(reloadMs);
		results.sessionMs.push(sessionMs);
		results.e2eMs.push(e2eMs);
		results.totalPhaseMs.push(performance.now() - tAll - e2eMs);

		// (5) fan-out ×3 as it happens today: three full setups in parallel
		const fanDirs = [makeDirs(), makeDirs(), makeDirs()];
		dirsList.push(...fanDirs);
		const tF = performance.now();
		await Promise.all(
			fanDirs.map(async (dir) => {
				const { session: nested, modelRuntime: rt, faux: fp } = await fullSetup(dir);
				fp.setResponses([fauxAssistantMessage("ok")]);
				await nested.prompt("go");
				nested.dispose();
				void rt;
			}),
		);
		results.fanout3Ms.push(performance.now() - tF);
	}

	for (const dirs of dirsList) {
		if (dirs.ephemeralCwd) rmSync(dirs.cwd, { recursive: true, force: true });
		rmSync(dirs.agentDir, { recursive: true, force: true });
	}

	const line = (label, key) => {
		const values = results[key];
		const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
		console.log(
			`${label.padEnd(34)} median ${median(values).toFixed(1).padStart(7)}ms   mean ${mean.toFixed(1).padStart(7)}ms   (n=${values.length})`,
		);
	};

	console.log(`pi-neo-subagents overhead profile — ${ITERATIONS} iterations, faux provider (no network)\n`);
	line("ModelRuntime.create", "setupMs");
	line("resourceLoader.reload", "reloadMs");
	line("createAgentSession", "sessionMs");
	line("full setup (3 phases)", "totalPhaseMs");
	line("nested prompt roundtrip (faux)", "e2eMs");
	line("fan-out x3 (3x setup, parallel)", "fanout3Ms");
	console.log(
		`\nFixed setup = runtime + reload + session = ${median(results.setupMs).toFixed(1)} + ${median(results.reloadMs).toFixed(1)} + ${median(results.sessionMs).toFixed(1)} = ${(median(results.setupMs) + median(results.reloadMs) + median(results.sessionMs)).toFixed(1)}ms per nested run.`,
	);
	console.log("A 3-task fan-out pays this 3× today (parallel, so wall-clock ≈ the x3 line).");
}

await main();
