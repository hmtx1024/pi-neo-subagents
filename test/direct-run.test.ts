/**
 * Ticket 06 — direct-run.
 *
 * Spec-level behaviour: users run a subagent themselves via
 * `/subagents run <name> <task>`; the result is presented to the user and kept
 * out of the model's context by default, with an option to send it into the
 * context so the main agent can continue from it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import type { TranscriptContext } from "@earendil-works/pi-ai";

import { createTestSession, userOutput } from "./harness.ts";

function writeReviewerDefinition(cwd: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "reviewer.md"),
		["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
	);
}

function captureTurn(captured: string[]): FauxResponseFactory {
	return (context: TranscriptContext) => {
		captured.push(JSON.stringify(context.messages));
		return fauxAssistantMessage("ok");
	};
}

it("presents a direct-run result to the user and keeps it out of the model's context by default", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);
		const captured: string[] = [];
		faux.setResponses([
			(_context) => fauxAssistantMessage("Looks good to me."),
			captureTurn(captured),
		]);

		await session.prompt("/subagents run reviewer Review the pending changes");
		expect(userOutput(ui)).toContain("Looks good to me.");

		await session.prompt("Next prompt.");
		expect(captured[0]).not.toContain("Looks good to me.");
	} finally {
		dispose();
	}
});

it("sends a direct-run result into the model's context when the user opts in", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);
		const captured: string[] = [];
		faux.setResponses([
			(_context) => fauxAssistantMessage("Looks good to me."),
			captureTurn(captured),
			captureTurn(captured),
		]);

		await session.prompt("/subagents run --to-context reviewer Review the pending changes");
		expect(userOutput(ui)).toContain("Looks good to me.");

		// The opted-in result triggers its own turn; wait for it to land.
		await vi.waitFor(
			() => {
				expect(captured.length).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 5_000 },
		);

		expect(captured.join("\n")).toContain("Looks good to me.");
	} finally {
		dispose();
	}
});
