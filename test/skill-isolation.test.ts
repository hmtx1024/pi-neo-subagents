/**
 * Nested subagent sessions must not inherit host-only prompt scaffolding such
 * as the skill index: a subagent sees the task and its definition, nothing else.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession } from "./harness.ts";

const MARKER = "DEMO-SKILL-MARKER";

function setupSkill({ agentDir }: { agentDir: string }): void {
	const dir = join(agentDir, "skills", "demo");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		["---", "name: demo", `description: ${MARKER} used by hermetic tests`, "---", "", "Demo body.", ""].join("\n"),
	);
}

function captureSystem(captured: string[]) {
	return (context: TranscriptContext) => {
		for (const message of context.messages) {
			if (message.role === "system") {
				captured.push(JSON.stringify(message));
			}
		}
		return fauxAssistantMessage("ok");
	};
}

it("keeps the host skill index out of the nested subagent prompt", async () => {
	const { session, faux, cwd, dispose } = await createTestSession({ setup: setupSkill });
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		const hostSaw: string[] = [];
		const subagentSaw: string[] = [];
		faux.setResponses([
			captureSystem(hostSaw),
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			(context: TranscriptContext) => {
				for (const message of context.messages) {
					if (message.role === "system") subagentSaw.push(JSON.stringify(message));
				}
				return fauxAssistantMessage("Nested reply.");
			},
			captureSystem(hostSaw),
		]);

		await session.prompt("Hello.");

		// Control: the host session does see the skill index.
		expect(hostSaw.join("\n")).toContain(MARKER);

		await session.prompt("Please delegate this to the reviewer.");
		expect(subagentSaw.length).toBeGreaterThan(0);
		expect(subagentSaw.join("\n")).not.toContain(MARKER);
		expect(subagentSaw.join("\n")).not.toContain("<skills>");
	} finally {
		dispose();
	}
});
