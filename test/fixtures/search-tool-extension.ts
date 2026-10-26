/**
 * Stand-in for a host-side search plugin: one extension tool named `web_search`.
 *
 * Used by the usage-issue reproductions to observe whether extension tools
 * cross into subagent sessions.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "web_search",
			label: "Web search",
			description: "Search the web and return results.",
			parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
			async execute(_toolCallId: string, params: { query: string }) {
				return { content: [{ type: "text" as const, text: `results for: ${params.query}` }], details: {} };
			},
		}),
	);
	// A tool that asks the user first: proves the bridge reaches the HOST UI.
	pi.registerTool(
		defineTool({
			name: "guarded_search",
			label: "Guarded web search",
			description: "Search the web after user approval.",
			parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
			async execute(
				_toolCallId: string,
				params: { query: string },
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionToolContext,
			) {
				const approved = await ctx.ui.confirm("Web search", `Allow search for ${params.query}?`);
				if (!approved) {
					return { content: [{ type: "text" as const, text: "denied" }], details: {}, isError: true };
				}
				return { content: [{ type: "text" as const, text: `guarded results for: ${params.query}` }], details: {} };
			},
		}),
	);
}
