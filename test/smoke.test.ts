/**
 * Smoke test for the agreed seam (ticket 01).
 *
 * Spec-level behaviour: the `task` tool is reachable from the model, and a
 * delegation attempted when no agent definitions exist fails with a clear,
 * model-visible error instead of misbehaving silently.
 */

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText } from "./harness.ts";

it("fails a task delegation with a clear error when no agent definitions exist", async () => {
	const { session, faux, dispose } = await createTestSession();
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as { isError: boolean; content: Array<{ type: string; text?: string }> } | undefined;

		expect(result).toBeDefined();
		expect(result!.isError).toBe(true);
		expect(toolResultText(result!)).toMatch(/no agent definitions/i);
	} finally {
		dispose();
	}
});
