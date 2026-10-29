/**
 * `create_subagent` — the model-facing way to add a definition. It owns the
 * location (project by default) and the file format, and validates before
 * writing, so a zero-definition session is never a dead end.
 */

import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import {
	createAgentDefinition,
	type DefinitionThinking,
} from "./agents.ts";
import { resolveModel } from "./delegate.ts";
import type { SubagentSettings } from "./settings.ts";

export const createSubagentParameters = Type.Object({
	name: Type.String({ description: "e.g. python-dev" }),
	description: Type.String({ description: "when to delegate" }),
	instructions: Type.String({ description: "markdown body" }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "built-ins + host extensions; a list narrows" })),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: 'skill whitelist; ["all"] = every user/project skill',
		}),
	),
	model: Type.Optional(Type.String({ description: "provider/id" })),
	maxTurns: Type.Optional(Type.Number({ description: "turn cap" })),
	maxTokens: Type.Optional(Type.Number({ description: "token cap" })),
	timeoutMs: Type.Optional(Type.Number({ description: "ms cap" })),
	thinking: Type.Optional(Type.String({ description: "thinking level" })),
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("user")], {
			description: "write scope",
		}),
	),
	overwrite: Type.Optional(Type.Boolean({ description: "replace same-name" })),
});

export interface CreateSubagentDetails {
	name: string;
	path: string;
	scope: "project" | "user";
}

/** `["all"]` is the wildcard; anything else is a name whitelist. Validation of
 * the shape (empty, `all` mixed with names) lives in `createAgentDefinition`. */
function normalizeSkillsParam(skills: string[] | undefined): "all" | string[] | undefined {
	if (skills === undefined) return undefined;
	const trimmed = skills.map((skill) => skill.trim()).filter(Boolean);
	if (trimmed.length === 1 && trimmed[0] === "all") return "all";
	return trimmed;
}

/**
 * `create_subagent` — the model-facing way to add a definition. It owns the
 * location (project by default) and the file format, and validates before
 * writing, so a zero-definition session is never a dead end.
 */
export function createCreateSubagentTool(getSettings: () => SubagentSettings) {
	return defineTool<typeof createSubagentParameters, CreateSubagentDetails>({
		name: "create_subagent",
		label: "Create subagent",
		description: [
			"Create a named subagent definition (Markdown + frontmatter) for the task tool.",
			'Project scope by default (travels with the repo); scope: "user" for the user directory.',
			"Existing definitions are replaced only with overwrite: true.",
		].join(" "),
		parameters: createSubagentParameters,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const settings = getSettings();
			if (!settings.allowModelCreatedDefinitions) {
				throw new Error(
					"Creating definitions is disabled in this session (subagents.allowModelCreatedDefinitions is false). Ask the user to create the definition instead.",
				);
			}
			if (params.scope === "user" && !settings.allowUserScopeCreation) {
				throw new Error(
					'User-scope creation is disabled (subagents.allowUserScopeCreation is false); use project scope, or ask the user to enable it.',
				);
			}
			// Creation validates against what this session can actually offer, so a
			// typo or an impossible model is caught now instead of at first delegation.
			const result = createAgentDefinition({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				name: params.name,
				description: params.description,
				instructions: params.instructions,
				tools: params.tools,
				skills: normalizeSkillsParam(params.skills),
				model: params.model,
				maxTurns: params.maxTurns,
				maxTokens: params.maxTokens,
				timeoutMs: params.timeoutMs,
				thinking: params.thinking as DefinitionThinking | undefined,
				scope: params.scope,
				overwrite: params.overwrite,
				validation: {
					availableTools: ctx.tools.map((tool) => tool.name),
					modelExists: (spec) => resolveModel(ctx.modelRegistry.getAll(), spec) !== undefined,
				},
			});
			if (!result.ok) {
				throw new Error(result.error);
			}
			const summary = [
				`Created agent definition "${params.name}" at ${result.path} (${result.scope} scope).`,
				`It is available immediately: task(agent: "${params.name}", task: "...").`,
			];
			if (result.shadowedUser) {
				summary.push(
					`Note: a user-level definition named "${params.name}" exists; this project definition takes precedence.`,
				);
			}
			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: { name: params.name, path: result.path, scope: result.scope },
			};
		},
	});
}

