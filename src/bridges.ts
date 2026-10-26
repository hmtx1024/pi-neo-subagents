/**
 * Bridging: host EXTENSION tools crossing into a nested subagent session.
 *
 * Built-ins are already available natively in the subagent; MCP and other
 * external tools are not. A bridge wrapper forwards to the host tool itself,
 * whose execution carries the host session's own context — UI dialogs and
 * permission behaviour included.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Tools a subagent never receives, even when a whitelist names them. */
export const BRIDGE_WITHHELD = new Set(["task", "create_subagent"]);

/** Minimal shape of a callable host tool (ctx.tools / getCallableTools()). */
export interface CallableTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: never,
		signal?: AbortSignal,
		onUpdate?: (result: never) => void,
	) => Promise<unknown>;
}

/**
 * Bridge wrappers for host EXTENSION tools (built-ins are already available
 * natively in the subagent; MCP and other external tools are not). The wrapper
 * forwards to the host tool itself, whose execution carries the host session's
 * own context — UI dialogs and permission behaviour included. The whitelist
 * filter happens at the delegation layer, per definition.
 */
export function buildBridges(ctx: unknown, pi: ExtensionAPI): ToolDefinition[] {
	const source = ctx as { tools?: readonly unknown[]; getCallableTools?: () => readonly unknown[] };
	const tools = (source.tools ?? source.getCallableTools?.() ?? []) as readonly CallableTool[];
	const builtin = new Set(
		pi.getAllTools().filter((info) => info.sourceInfo?.source === "builtin").map((info) => info.name),
	);
	return tools
		.filter((tool) => !BRIDGE_WITHHELD.has(tool.name) && !builtin.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters as ToolDefinition["parameters"],
			execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: (result: never) => void) =>
				tool.execute(toolCallId, params, signal, onUpdate),
			// The host's callable tools and `defineTool`'s parameter generic are not
			// structurally identical (both are opaque at this boundary), so the
			// wrapper is asserted rather than inferred; the shape is exercised at
			// runtime when the nested session registers it.
		})) as ToolDefinition[];
}

