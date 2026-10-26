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

interface ToolInfoLike {
	name: string;
	description?: string;
	parameters?: unknown;
}

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

it("auto-bridges host extension tools when the delegation names no whitelist", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		// No `tools:` field: the subagent gets pi's defaults AND the host's
		// extension tools — the host's own semantics (real-usage lesson: an
		// ad-hoc research task lost its search plugin and degraded to scraping).
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
				return fauxAssistantMessage("found it");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(nestedToolNames).toContain("web_search");
		expect(searchResult).toContain("results for: pi");
		// Withheld tools stay withheld even in the permissive mode.
		expect(nestedToolNames).not.toContain("task");
		expect(nestedToolNames).not.toContain("create_subagent");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
	} finally {
		dispose();
	}
});

it("auto-bridges for ad-hoc delegations without a tools field", async () => {
	const { session, faux, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		let nestedToolNames: string[] = [];
		let searchResult = "";

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { instructions: "You search things.", task: "Search for pi" }),
				{ stopReason: "toolUse" },
			),
			(context: TranscriptContext) => {
				nestedToolNames = recordToolsAdded(context);
				return fauxAssistantMessage(fauxToolCall("web_search", { query: "pi" }), { stopReason: "toolUse" });
			},
			(context: TranscriptContext) => {
				searchResult = nestedToolResultText(context, "web_search");
				return fauxAssistantMessage("ad-hoc found it");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate inline.");

		expect(nestedToolNames).toContain("web_search");
		expect(searchResult).toContain("results for: pi");
	} finally {
		dispose();
	}
});

it("narrows strictly when a whitelist is given but does not name the extension tool", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		extraExtensionPaths: [SEARCH_EXTENSION],
	});
	try {
		writeAgent(root, "reader", ["tools: read"]);
		let nestedToolNames: string[] = [];
		let searchResult = "";

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "reader", task: "Try searching" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nestedToolNames = recordToolsAdded(context);
				return fauxAssistantMessage(fauxToolCall("web_search", { query: "pi" }), { stopReason: "toolUse" });
			},
			(context: TranscriptContext) => {
				searchResult = nestedToolResultText(context, "web_search");
				return fauxAssistantMessage("could not search");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		// A named whitelist is an allowlist: web_search stays out.
		expect(nestedToolNames).not.toContain("web_search");
		expect(nestedToolNames).toContain("read");
		expect(searchResult).toMatch(/not found|not registered/i);
	} finally {
		dispose();
	}
});

it("keeps the schema honest about what omitting tools grants", async () => {
	const { session, dispose } = await createTestSession();
	const tools = session.getAllTools() as unknown as ToolInfoLike[];
	for (const name of ["task", "create_subagent"]) {
		const tool = tools.find((candidate) => candidate.name === name);
		const json = JSON.stringify(tool?.parameters ?? {});
		expect(json, `${name} tools description`).toContain("built-ins + host extensions");
		expect(json, `${name} must not claim "omit = all"`).not.toContain("omit = all");
	}
	dispose();
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
			(_context: TranscriptContext) => {
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
			(_context: TranscriptContext) => {
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
	const { session, faux, dispose } = await createTestSession();
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

it("explains a missing tool without claiming extension tools must be named", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		// A name the session cannot provide. Since 0.1.6 extension tools bridge by
		// default, so the old "only when listed in tools" advice is backwards.
		writeAgent(root, "reader", ["tools: read, nosuchtool"]);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "reader", task: "Try it" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const text = toolText(lastToolResult(session, "task"));
		expect(text).toContain("nosuchtool");
		expect(text).not.toMatch(/only when .*listed in .?tools/i);
		expect(text).toMatch(/host session|task tool/i);
	} finally {
		dispose();
	}
});
