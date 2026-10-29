/**
 * Nested subagent sessions must not inherit host-only prompt scaffolding such
 * as the skill index — unless a definition explicitly whitelists skills via its
 * `skills` frontmatter. The default stays fully isolated; the opt-in cases
 * below pin what crosses (the named/all skills) and what stays out.
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

/** Write several user-level skills; `names` become both dir + skill names. */
function setupSkills(names: string[]): (dirs: { agentDir: string }) => void {
	return ({ agentDir }) => {
		for (const name of names) {
			const dir = join(agentDir, "skills", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				[
					"---",
					`name: ${name}`,
					`description: SKILL-${name}-MARKER for hermetic tests`,
					"---",
					"",
					`${name} body.`,
					"",
				].join("\n"),
			);
		}
	};
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

it("loads the whitelisted skill's index into the nested prompt when the definition names it", async () => {
	const { session, faux, cwd, dispose } = await createTestSession({ setup: setupSkill });
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "skills: demo", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		const subagentSaw: string[] = [];
		faux.setResponses([
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
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please delegate this to the reviewer.");
		const seen = subagentSaw.join("\n");
		expect(seen).toContain(MARKER);
		expect(seen).toContain("<available_skills>");
	} finally {
		dispose();
	}
});

it("narrows the index to the named skills and drops the rest", async () => {
	const { session, faux, cwd, dispose } = await createTestSession({ setup: setupSkills(["alpha-skill", "beta-skill"]) });
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "skills: alpha-skill", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		const subagentSaw: string[] = [];
		faux.setResponses([
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
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please delegate this to the reviewer.");
		const seen = subagentSaw.join("\n");
		expect(seen).toContain("SKILL-alpha-skill-MARKER");
		expect(seen).not.toContain("SKILL-beta-skill-MARKER");
	} finally {
		dispose();
	}
});

it("silently drops a whitelisted name that resolves to no skill", async () => {
	const { session, faux, cwd, dispose } = await createTestSession({ setup: setupSkill });
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "skills: nonexistent-skill", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		const subagentSaw: string[] = [];
		faux.setResponses([
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
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please delegate this to the reviewer.");
		// The delegation succeeds; the absent name is simply not in the index.
		const seen = subagentSaw.join("\n");
		expect(seen).not.toContain("<available_skills>");
		expect(seen).not.toContain(MARKER);
	} finally {
		dispose();
	}
});

it("keeps ad-hoc delegations skill-free even when skills exist on disk", async () => {
	const { session, faux, dispose } = await createTestSession({ setup: setupSkill });
	try {
		const subagentSaw: string[] = [];
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { instructions: "You are a careful worker.", task: "Do the thing" }),
				{ stopReason: "toolUse" },
			),
			(context: TranscriptContext) => {
				for (const message of context.messages) {
					if (message.role === "system") subagentSaw.push(JSON.stringify(message));
				}
				return fauxAssistantMessage("Nested reply.");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Do the thing inline.");
		const seen = subagentSaw.join("\n");
		expect(seen).not.toContain(MARKER);
		expect(seen).not.toContain("<available_skills>");
	} finally {
		dispose();
	}
});
