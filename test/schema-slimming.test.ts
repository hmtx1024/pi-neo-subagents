/**
 * Ticket 04 — host-side schema/description slimming.
 *
 * Baseline (ticket 03 profiling, 1 agent definition):
 *   task            desc 273 + params 834 = 1,107 tokens
 *   create_subagent desc  85 + params 303 =   388 tokens
 *   combined 1,495 tokens — the host pays them on EVERY turn.
 *
 * The structural JSON (keys/types) is a ~42% floor; the trimmable part is
 * description text. Sizes are measured at the session boundary through
 * `session.getAllTools()` — the same ToolInfo the model's request carries.
 *
 * Red-line anchors below lock the guidance meanings that v1 live testing paid
 * for; they must survive any trim.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession } from "./harness.ts";

/** Mirrors pi's internal text estimator (Math.ceil(len / 4)). */
function tok(text: string): number {
	return Math.ceil(text.length / 4);
}

interface ToolInfoLike {
	name: string;
	description?: string;
	parameters?: unknown;
}

function writeAgent(root: string, name: string, description: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"),
	);
}

function toolSize(tools: ToolInfoLike[], name: string): { desc: number; params: number; description: string; json: string } {
	const tool = tools.find((candidate) => candidate.name === name);
	expect(tool, `tool ${name} missing`).toBeDefined();
	const description = tool!.description ?? "";
	const json = JSON.stringify(tool!.parameters ?? {});
	return { desc: tok(description), params: tok(json), description, json };
}

it("keeps the task tool schema lean while the guidance survives", async () => {
	const { session, dispose } = await createTestSession({
		// One definition, written before the session loads: the description is
		// built at load/refresh time, so setup is the only way to pin its size.
		setup: ({ cwd }) => writeAgent(cwd, "alpha", "Does alpha work"),
	});
	const tools = session.getAllTools() as unknown as ToolInfoLike[];
	const task = toolSize(tools, "task");

	// Ticket target was 180; the guard is 200 because the description embeds
	// absolute paths whose length varies by machine (Windows CI runners are
	// ~40 chars longer than Linux ones). Real regressions are far bigger.
	expect(task.desc).toBeLessThanOrEqual(200);
	expect(task.params).toBeLessThanOrEqual(580);

	// Field completeness: nothing functional may be removed to save tokens.
	for (const field of [
		"agent",
		"instructions",
		"tools",
		"model",
		"task",
		"tasks",
		"chain",
		"maxTurns",
		"maxTokens",
		"timeoutMs",
		"thinking",
	]) {
		expect(task.json, `field ${field} vanished from params`).toContain(`"${field}"`);
	}

	// Red-line anchors (v1 lessons + v2 guidance), meanings pinned:
	expect(task.description).toMatch(/self-contained/i);
	expect(task.description).toMatch(/sees nothing else/);
	expect(task.description).toMatch(/\{previous\}/); // chain reference documented
	expect(task.description).toMatch(/\btasks\b/); // fan-out shape documented
	expect(task.description).toMatch(/\bchain\b/); // chain shape documented
	expect(task.description).toMatch(/instructions/); // ad-hoc path documented
	expect(task.description).toMatch(/create_subagent/); // creation guidance stays
	expect(task.description).toMatch(/extension tool/); // bridging rule stays
	expect(task.description).toMatch(/tools/); // whitelist rule stays
	dispose();
});

it("keeps create_subagent's schema lean", async () => {
	const { session, dispose } = await createTestSession();
	const tools = session.getAllTools() as unknown as ToolInfoLike[];
	const create = toolSize(tools, "create_subagent");

	expect(create.desc).toBeLessThanOrEqual(70);
	// 210 → 240: the `skills` whitelist field (ticket: subagent skill access)
	// costs ~30 tokens of real schema; no description fat was added.
	expect(create.params).toBeLessThanOrEqual(240);
	for (const field of ["name", "description", "instructions", "tools", "model", "skills", "scope", "overwrite"]) {
		expect(create.json, `field ${field} vanished from create params`).toContain(`"${field}"`);
	}
	expect(create.description).toMatch(/create|definition/i);
	dispose();
});

it("keeps the combined host tool surface under budget", async () => {
	const { session, dispose } = await createTestSession();
	const tools = session.getAllTools() as unknown as ToolInfoLike[];
	const total =
		toolSize(tools, "task").desc +
		toolSize(tools, "task").params +
		toolSize(tools, "create_subagent").desc +
		toolSize(tools, "create_subagent").params;

	// Baseline 1,495 → target ≤1,020 (−32%); stretch ≤897 (−40%).
	// 1,020 → 1,045 with the `skills` field above; every other trim intact.
	expect(total).toBeLessThanOrEqual(1045);
	dispose();
});

it("delegates normally with the slimmed schema", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "alpha", "Does alpha work");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "alpha", task: "Do the thing" }), {
				stopReason: "toolUse",
			}),
			() => fauxAssistantMessage("alpha did it"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const results = (session.messages as Array<{ role: string; toolName?: string; content: Array<{ type: string; text?: string }> }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		);
		const text = results[results.length - 1].content.map((block) => block.text ?? "").join("");
		expect(text).toBe("alpha did it");
	} finally {
		dispose();
	}
});
