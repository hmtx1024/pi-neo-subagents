/**
 * Ticket 02 — extension tool bridging.
 *
 * Host extension tools (search plugins and the like) never reached subagents:
 * nested sessions disable extensions outright, while creation validated tool
 * names against the HOST tool map — a definition could promise a tool that
 * could never exist, and the model hit `Tool X not found`. Now a named
 * extension tool is bridged into the nested session, withheld tools fail loud
 * at creation, and a whitelist that cannot be satisfied fails the delegation
 * with the missing names.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, userOutput } from "./harness.ts";

const SEARCH_EXTENSION = fileURLToPath(new URL("./fixtures/search-tool-extension.ts", import.meta.url));

interface ToolResultMessage {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
}

function lastToolResult(session: { messages: unknown[] }, toolName: string): ToolResultMessage {
	const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	return results[results.length - 1] as unknown as ToolResultMessage;
}

function toolText(result: ToolResultMessage): string {
	return result.content.map((block) => block.text ?? "").join("");
}

function writeAgent(root: string, name: string, frontmatter: string[] = []): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `description: The ${name} agent`, ...frontmatter, "---", "", "Body.", ""].join("\n"),
	);
}

/** Tools the nested model saw, from the system message's registration trace. */
function recordToolsAdded(context: TranscriptContext): string[] {
	const names: string[] = [];
	for (const message of context.messages) {
		const added = (message as { toolsAdded?: Array<{ name?: string }> }).toolsAdded;
		if (!Array.isArray(added)) continue;
		for (const entry of added) if (entry?.name) names.push(entry.name);
	}
	return names;
}

/** Text of a tool result for `toolName` inside a captured transcript. */
function nestedToolResultText(context: TranscriptContext, toolName: string): string {
	const texts: string[] = [];
	for (const message of context.messages) {
		if (message.role !== "toolResult" || (message as { toolName?: string }).toolName !== toolName) continue;
		for (const block of (message as { content?: Array<{ type: string; text?: string }> }).content ?? []) {
			if (block.text) texts.push(block.text);
		}
	}
	return texts.join("\n");
}

it("exposes a named host extension tool in the subagent and runs it through the host", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		writeAgent(root, "researcher", ["tools: read, web_search"]);
		let nestedToolNames: string[] = [];
		let webSearchResult = "";
		let reply = "";

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "researcher", task: "Search for pi docs" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nestedToolNames = recordToolsAdded(context);
				return fauxAssistantMessage(fauxToolCall("web_search", { query: "pi docs" }), { stopReason: "toolUse" });
			},
			(context: TranscriptContext) => {
				webSearchResult = nestedToolResultText(context, "web_search");
				reply = "found results";
				return fauxAssistantMessage(reply);
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate a search.");

		// The promised tool now actually exists in the subagent ...
		expect(nestedToolNames).toContain("web_search");
		// ... and executing it produces the HOST implementation's output, not
		// the old `Tool web_search not found` dead end.
		expect(webSearchResult).toContain("results for: pi docs");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolText(result)).toContain(reply);
	} finally {
		dispose();
	}
});

it("keeps whitelist purity: a bridged tool does not drag built-ins in", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		writeAgent(root, "searcher", ["tools: web_search"]);
		let nestedToolNames: string[] = [];
		let readResult = "";

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "searcher", task: "Search only" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nestedToolNames = recordToolsAdded(context);
				return fauxAssistantMessage(fauxToolCall("read", { path: "/nonexistent" }), { stopReason: "toolUse" });
			},
			(context: TranscriptContext) => {
				readResult = nestedToolResultText(context, "read");
				return fauxAssistantMessage("searched");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(nestedToolNames).toContain("web_search");
		expect(nestedToolNames).not.toContain("read");
		expect(readResult).toMatch(/not found|not registered/i);
	} finally {
		dispose();
	}
});

it("does not bridge anything without an explicit whitelist", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		// No `tools:` field: the subagent keeps pi's defaults only.
		writeAgent(root, "helper");
		let nestedToolNames: string[] = [];
		let searchResult = "";

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "helper", task: "Search for pi" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nestedToolNames = recordToolsAdded(context);
				return fauxAssistantMessage(fauxToolCall("web_search", { query: "pi" }), { stopReason: "toolUse" });
			},
			(context: TranscriptContext) => {
				searchResult = nestedToolResultText(context, "web_search");
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(nestedToolNames).toContain("read");
		expect(nestedToolNames).not.toContain("web_search");
		expect(searchResult).toMatch(/not found|not registered/i);
	} finally {
		dispose();
	}
});

it("refuses a whitelist containing withheld or unprovidable tools, naming them", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		// Hand-written definition asking for the two management tools.
		writeAgent(root, "chaos", ["tools: read, task, create_subagent"]);
		let reply = "";

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "chaos", task: "Do something" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				reply = "I should never run";
				return fauxAssistantMessage(reply);
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBe(true);
		const text = toolText(result);
		expect(text).toContain("task");
		expect(text).toContain("create_subagent");
		expect(text).not.toBe(reply);
	} finally {
		dispose();
	}
});

it("runs a bridged tool that asks the user through the HOST ui", async () => {
	const { session, faux, ui, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		writeAgent(root, "guarded", ["tools: guarded_search"]);
		let guardedResult = "";

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "guarded", task: "Search pi" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				return fauxAssistantMessage(fauxToolCall("guarded_search", { query: "pi" }), { stopReason: "toolUse" });
			},
			(context: TranscriptContext) => {
				guardedResult = nestedToolResultText(context, "guarded_search");
				return fauxAssistantMessage("done searching");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(guardedResult).toContain("guarded results for: pi");
		expect(ui.dialogCalls.some((call) => call.method === "confirm" && call.title === "Web search")).toBe(true);
	} finally {
		dispose();
	}
});

it("rejects creation when a definition asks for a withheld tool", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "sneaky",
					description: "Tries to manage definitions",
					instructions: "You are sneaky.",
					tools: ["read", "create_subagent"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a definition.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain("create_subagent");
	} finally {
		dispose();
	}
});

it("refuses an unbridgeable whitelist on the direct-run surface with a clear message", async () => {
	const { session, faux, ui, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		writeAgent(root, "researcher", ["tools: read, web_search"]);

		faux.setResponses([]);

		await session.prompt("/subagents run researcher Search for pi docs");

		// Command contexts cannot reach host tools, so the delegation fails
		// loudly instead of silently dropping the promised tool.
		const output = userOutput(ui);
		expect(output).toContain("web_search");
		expect(output).toMatch(/cannot provide/i);
		expect(output).not.toContain("direct results");
	} finally {
		dispose();
	}
});
