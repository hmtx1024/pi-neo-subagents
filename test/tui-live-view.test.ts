/**
 * Ticket 06 — live subagent view in the TUI.
 *
 * While delegations run the TUI shows which agents are in flight, their turn,
 * and their current tool, then clears itself. Non-interactive modes never touch
 * the widget.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession } from "./harness.ts";

function writeAgent(root: string, name: string, description: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), ["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"));
}

function hostDelegation(agent: string) {
	return fauxAssistantMessage(fauxToolCall("task", { agent, task: "Do it." }), { stopReason: "toolUse" });
}

it("shows the agent, its turn, and the current tool while it runs, then clears", async () => {
	const { session, faux, ui, root, dispose } = await createTestSession({ mode: "tui" });
	try {
		writeAgent(root, "reviewer", "Reviews code");
		faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage([fauxText("looking"), fauxToolCall("bash", { command: "echo hi" })], {
				stopReason: "toolUse",
			}),
			(_context) => fauxAssistantMessage("done"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const lines = ui.widgets.flatMap((widget) => widget.lines ?? []);
		expect(lines.some((line) => line.includes("reviewer") && /turn 1/.test(line))).toBe(true);
		expect(lines.some((line) => line.includes("bash"))).toBe(true);

		// The widget is cleared once the dispatch settles.
		expect(ui.widgets[ui.widgets.length - 1].lines).toBeUndefined();
	} finally {
		dispose();
	}
});

it("shows one row per in-flight task in a fan-out", async () => {
	const { session, faux, ui, root, dispose } = await createTestSession({ mode: "tui" });
	try {
		writeAgent(root, "reviewer", "Reviews code");
		writeAgent(root, "scout", "Explores code");

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = async (context: { messages: unknown[] }) => {
			await gate;
			return fauxAssistantMessage("slow reply");
		};

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [
						{ agent: "reviewer", task: "one" },
						{ agent: "scout", task: "two" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			slow as never,
			slow as never,
			fauxAssistantMessage("Understood."),
		]);

		const prompt = session.prompt("Fan out.");
		await new Promise((resolve) => setTimeout(resolve, 80));

		const duringRun = ui.widgets[ui.widgets.length - 1];
		expect(duringRun.lines).toBeDefined();
		expect(duringRun.lines?.length).toBe(2);
		expect(duringRun.lines?.join("\n")).toContain("reviewer");
		expect(duringRun.lines?.join("\n")).toContain("scout");

		release();
		await prompt;
		expect(ui.widgets[ui.widgets.length - 1].lines).toBeUndefined();
	} finally {
		dispose();
	}
});

it("never uses the widget outside the TUI", async () => {
	for (const mode of ["print", "json", "rpc"] as const) {
		const { session, faux, ui, root, dispose } = await createTestSession({ mode });
		try {
			writeAgent(root, "reviewer", "Reviews code");
			faux.setResponses([hostDelegation("reviewer"), fauxAssistantMessage("reply"), fauxAssistantMessage("ok")]);

			await session.prompt("Delegate.");

			expect(ui.widgets).toHaveLength(0);
		} finally {
			dispose();
		}
	}
});

it("drops a failed task from the view but still reports it", async () => {
	const { session, faux, ui, root, dispose } = await createTestSession({ mode: "tui" });
	try {
		writeAgent(root, "reviewer", "Reviews code");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [
						{ agent: "reviewer", task: "one" },
						{ agent: "ghost", task: "two" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("reply"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Fan out.");

		const finalWidget = ui.widgets[ui.widgets.length - 1];
		expect(finalWidget.lines).toBeUndefined();

		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as unknown as Array<{ content: Array<{ type: string; text?: string }> }>;
		const text = results[results.length - 1].content.map((block) => block.text ?? "").join("");
		expect(text).toContain("ghost");
		expect(text).toMatch(/failed/i);
	} finally {
		dispose();
	}
});

it("clears the live row when the delegation fails before it starts", async () => {
	const { session, faux, ui, dispose } = await createTestSession({ mode: "tui" });
	try {
		// Unknown agent: delegateTask throws after the row was seeded, so the
		// cleanup has to live in a finally — otherwise the row is a ghost that
		// sits on screen until the next delegation.
		faux.setResponses([
			hostDelegation("does-not-exist"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(ui.widgets[ui.widgets.length - 1].lines).toBeUndefined();
	} finally {
		dispose();
	}
});

it("drops a settled chain step while the next one is still running", async () => {
	const { session, faux, ui, root, dispose } = await createTestSession({ mode: "tui" });
	try {
		writeAgent(root, "first", "Runs first");
		writeAgent(root, "second", "Runs second");

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = async () => {
			await gate;
			return fauxAssistantMessage("second reply");
		};

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					chain: [
						{ agent: "first", task: "one" },
						{ agent: "second", task: "two {previous}" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("first reply"),
			slow as never,
			fauxAssistantMessage("Understood."),
		]);

		const prompt = session.prompt("Chain it.");
		await new Promise((resolve) => setTimeout(resolve, 80));

		// Step one was visible while it ran, then disappeared the moment it
		// settled — a chain must not accumulate one row per completed step.
		const snapshots = ui.widgets.map((widget) => widget.lines?.join("\n") ?? "");
		expect(snapshots.some((lines) => lines.includes("first"))).toBe(true);
		const duringRun = ui.widgets[ui.widgets.length - 1].lines?.join("\n") ?? "";
		expect(duringRun).not.toContain("first");

		release();
		await prompt;
		expect(ui.widgets[ui.widgets.length - 1].lines).toBeUndefined();
	} finally {
		dispose();
	}
});
