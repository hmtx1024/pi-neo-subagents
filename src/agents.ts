/**
 * Agent definitions: discovery and parsing (Markdown + frontmatter).
 *
 * Internal module — tests observe it only through the extension's
 * user-facing surface (commands, task tool).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Thinking levels a definition may pin (matches Pi's session thinking levels). */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type DefinitionThinking = (typeof THINKING_LEVELS)[number];

export interface AgentDefinition {
	/** File name of the definition, for error messages. */
	file: string;
	/** Canonical agent name (frontmatter `name`, else the file's stem). */
	name: string;
	description: string;
	/** Allowed tools (frontmatter `tools`); omitted means all default tools. */
	tools?: string[];
	/** Pinned model (frontmatter `model`); omitted means inherit the host session's model. */
	model?: string;
	/** `replace` makes the body the entire system prompt (default: append to Pi's default prompt). */
	systemPrompt?: string;
	/** Turn cap for a delegation of this agent; omitted means unbounded. */
	maxTurns?: number;
	/** Wall-clock cap in milliseconds; omitted means unbounded. */
	timeoutMs?: number;
	/** Token cap for a delegation of this agent; omitted means unbounded. */
	maxTokens?: number;
	/** Thinking level pinned for this agent; omitted means inherit. */
	thinking?: DefinitionThinking;
	/** Whether this agent may spawn subagents of its own (default: no). */
	allowSubagents?: boolean;
	/** Markdown body: the agent's specialization instructions. */
	body: string;
	/** Which resource directory the definition came from. */
	source: "project" | "user";
	/** True when this project-level definition shadows a user-level one of the same name. */
	overridesUser: boolean;
	/** File modification time in milliseconds, for the listing. */
	modifiedAt?: number;
}

export interface DefinitionError {
	/** File name of the broken definition. */
	file: string;
	message: string;
}

export interface AgentSet {
	agents: AgentDefinition[];
	errors: DefinitionError[];
}

export interface Discovery extends AgentSet {
	/** Directory the project-level definitions were resolved from. */
	projectAgentsDir: string;
}

const PROJECT_AGENTS_PATH = [".pi", "agents"] as const;

/**
 * Nearest directory (from the working directory upwards) that already holds
 * project-level definitions, so running Pi inside a subdirectory still finds the
 * repository's agents. Falls back to the working directory itself.
 */
export function resolveProjectAgentsDir(cwd: string): string {
	let current = cwd;
	while (true) {
		const candidate = join(current, ...PROJECT_AGENTS_PATH);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(cwd, ...PROJECT_AGENTS_PATH);
		current = parent;
	}
}

/**
 * Discover agent definitions from the project-level and user-level resource
 * directories. Project-level wins on a name collision.
 */
export function discoverAgents(cwd: string, agentDir: string): Discovery {
	const projectAgentsDir = resolveProjectAgentsDir(cwd);
	const user = discoverAgentsIn(join(agentDir, "agents"), "user");
	const project = discoverAgentsIn(projectAgentsDir, "project");
	const userNames = new Set(user.agents.map((agent) => agent.name));
	return {
		agents: [
			...project.agents.map((agent) =>
				userNames.has(agent.name) ? { ...agent, overridesUser: true } : agent,
			),
			...user.agents.filter((agent) => !project.agents.some((p) => p.name === agent.name)),
		],
		errors: [...project.errors, ...user.errors],
		projectAgentsDir,
	};
}

/** Discover agent definitions (Markdown + frontmatter) in one directory. */
export function discoverAgentsIn(dir: string, source: "project" | "user"): AgentSet {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { agents: [], errors: [] };
	}
	const agents: AgentDefinition[] = [];
	const errors: DefinitionError[] = [];
	// Deterministic order: file name decides which duplicate wins.
	const seen = new Map<string, string>();
	for (const file of entries.filter((entry) => entry.endsWith(".md")).sort()) {
		const result = parseAgentFile(join(dir, file), file, source);
		if (!result.ok) {
			errors.push(result.error);
			continue;
		}
		const existing = seen.get(result.agent.name);
		if (existing !== undefined) {
			errors.push({
				file,
				message: `duplicate agent name "${result.agent.name}" (already defined by ${existing})`,
			});
			continue;
		}
		seen.set(result.agent.name, file);
		agents.push(result.agent);
	}
	return { agents, errors };
}

type ParseResult = { ok: true; agent: AgentDefinition } | { ok: false; error: DefinitionError };

function parseAgentFile(path: string, file: string, source: "project" | "user"): ParseResult {
	const result = parseAgentText(readFileSync(path, "utf-8"), file, source);
	if (!result.ok) return result;
	let modifiedAt: number | undefined;
	try {
		modifiedAt = statSync(path).mtimeMs;
	} catch {
		modifiedAt = undefined;
	}
	return { ok: true, agent: { ...result.agent, ...(modifiedAt === undefined ? {} : { modifiedAt }) } };
}

/** Parse definition text (used for discovery and for validating generated definitions). */
export function parseAgentText(raw: string, file: string, source: "project" | "user"): ParseResult {
	const split = splitFrontmatter(raw);
	if (!split.ok) {
		return { ok: false, error: { file, message: split.error } };
	}
	const { frontmatter, body } = split;

	const description = frontmatter.description;
	if (description === undefined || description === "") {
		return { ok: false, error: { file, message: 'missing required "description" in frontmatter' } };
	}
	if (Array.isArray(description)) {
		return { ok: false, error: { file, message: '"description" must be a single line' } };
	}

	// A present-but-empty `tools` key used to fall back to "all default tools",
	// which silently widened the whitelist. Treat it as an error instead.
	let tools: string[] | undefined;
	const rawTools = frontmatter.tools;
	if (rawTools !== undefined) {
		const items = Array.isArray(rawTools) ? rawTools : rawTools.split(",");
		const parsed = items.map((tool) => tool.trim()).filter(Boolean);
		if (parsed.length === 0) {
			return { ok: false, error: { file, message: '"tools" must not be empty' } };
		}
		tools = parsed;
	}

	for (const key of ["name", "model", "systemPrompt", "maxTurns", "timeoutMs", "maxTokens", "thinking"] as const) {
		if (Array.isArray(frontmatter[key])) {
			return { ok: false, error: { file, message: `"${key}" must be a single value` } };
		}
	}

	const limits: { maxTurns?: number; timeoutMs?: number; maxTokens?: number } = {};
	for (const key of ["maxTurns", "timeoutMs", "maxTokens"] as const) {
		const raw = frontmatter[key];
		if (raw === undefined) continue;
		const value = typeof raw === "string" ? raw.trim() : "";
		if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
			return { ok: false, error: { file, message: `"${key}" must be a positive integer` } };
		}
		limits[key] = Number(value);
	}

	if (frontmatter.systemPrompt !== undefined && frontmatter.systemPrompt !== "replace") {
		return {
			ok: false,
			error: {
				file,
				message: `"systemPrompt" must be "replace" when present (got "${frontmatter.systemPrompt}"); omit it to append to Pi's default prompt`,
			},
		};
	}

	let allowSubagents: boolean | undefined;
	if (frontmatter.allowSubagents !== undefined) {
		const raw = frontmatter.allowSubagents as string;
		if (raw !== "true" && raw !== "false") {
			return { ok: false, error: { file, message: `"allowSubagents" must be true or false (got "${raw}")` } };
		}
		allowSubagents = raw === "true";
	}

	let thinking: DefinitionThinking | undefined;
	if (frontmatter.thinking !== undefined) {
		const raw = frontmatter.thinking as string;
		if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
			return {
				ok: false,
				error: { file, message: `"thinking" must be one of: ${THINKING_LEVELS.join(", ")}` },
			};
		}
		thinking = raw as DefinitionThinking;
	}

	const name = frontmatter.name;
	return {
		ok: true,
		agent: {
			file,
			name: typeof name === "string" && name !== "" ? name : file.replace(/\.md$/, ""),
			description,
			tools,
			model: frontmatter.model as string | undefined,
			systemPrompt: frontmatter.systemPrompt as string | undefined,
			...limits,
			...(thinking ? { thinking } : {}),
			...(allowSubagents === undefined ? {} : { allowSubagents }),
			body,
			source,
			overridesUser: false,
		},
	};
}

type FrontmatterValue = string | string[];

type ScalarResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Parse one frontmatter scalar the way users actually write it: optional
 * surrounding quotes (kept out of the value) and trailing `#` comments.
 */
function parseScalar(raw: string): ScalarResult {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: true, value: "" };
	}
	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		const closing = trimmed.indexOf(quote, 1);
		if (closing === -1) {
			return { ok: false, error: `unterminated quoted value: ${trimmed}` };
		}
		const value = trimmed.slice(1, closing);
		const rest = trimmed.slice(closing + 1).trim();
		if (rest !== "" && !rest.startsWith("#")) {
			return { ok: false, error: `unexpected content after quoted value: ${trimmed}` };
		}
		return { ok: true, value };
	}
	if (trimmed.startsWith("#")) {
		return { ok: true, value: "" };
	}
	const comment = trimmed.search(/\s#/);
	return { ok: true, value: comment === -1 ? trimmed : trimmed.slice(0, comment).trim() };
}

function splitFrontmatter(
	raw: string,
):
	| { ok: true; frontmatter: Record<string, FrontmatterValue>; body: string }
	| { ok: false; error: string } {
	const lines = raw.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { ok: true, frontmatter: {}, body: raw };
	}
	const frontmatter: Record<string, FrontmatterValue> = {};
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") break;
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const match = /^\s*([A-Za-z][\w-]*)\s*:(.*)$/.exec(line);
		if (!match) {
			return { ok: false, error: `unparseable frontmatter line: ${line.trim()}` };
		}
		const key = match[1];
		const scalar = parseScalar(match[2]);
		if (!scalar.ok) {
			return { ok: false, error: scalar.error };
		}
		if (scalar.value !== "") {
			frontmatter[key] = scalar.value;
			continue;
		}
		// YAML block sequence: `key:` followed by `- item` lines.
		const items: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const item = /^\s*-\s+(.*)$/.exec(lines[j]);
			if (!item) break;
			const parsedItem = parseScalar(item[1]);
			if (!parsedItem.ok) {
				return { ok: false, error: parsedItem.error };
			}
			if (parsedItem.value !== "") items.push(parsedItem.value);
		}
		if (items.length > 0) {
			frontmatter[key] = items;
			i = j - 1;
		} else {
			// Present but empty: keep it so callers can reject it explicitly.
			frontmatter[key] = "";
		}
	}
	if (i >= lines.length) {
		return { ok: false, error: 'frontmatter is not closed (missing "---")' };
	}
	return { ok: true, frontmatter, body: lines.slice(i + 1).join("\n") };
}

export type AgentScope = "project" | "user";

/** Directory that holds definitions for one scope. */
export function agentsDirFor(cwd: string, agentDir: string, scope: AgentScope): string {
	return scope === "project" ? join(cwd, ".pi", "agents") : join(agentDir, "agents");
}

/** What the creating session can offer; used to reject impossible definitions. */
export interface CreationValidation {
	/** Tool names registered in the creating session. */
	availableTools?: readonly string[];
	/** Whether a model spec resolves against the current registry. */
	modelExists?: (spec: string) => boolean;
}

export interface CreateDefinitionRequest {
	cwd: string;
	/** User-level agent directory (pi's `getAgentDir()`). */
	agentDir: string;
	/** Project directory to write into; resolved from the working directory when omitted. */
	projectAgentsDir?: string;
	name: string;
	description: string;
	instructions: string;
	tools?: string[];
	model?: string;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinking?: DefinitionThinking;
	validation?: CreationValidation;
	/** Defaults to "project": project definitions travel with the repository. */
	scope?: AgentScope;
	overwrite?: boolean;
}

export type CreateDefinitionResult =
	| { ok: true; path: string; scope: AgentScope; shadowedUser: boolean }
	| { ok: false; error: string };

/** File name for a definition: a slug, while the canonical name lives in frontmatter. */
function slugFor(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "agent" : slug;
}

/** Render a definition file: frontmatter (only what was provided) plus the body. */
export function renderAgentMarkdown(request: {
	name: string;
	description: string;
	instructions: string;
	tools?: string[];
	model?: string;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinking?: DefinitionThinking;
}): string {
	const frontmatter = [`name: ${request.name}`, `description: ${request.description}`];
	if (request.tools && request.tools.length > 0) {
		frontmatter.push(`tools: ${request.tools.join(", ")}`);
	}
	if (request.model) {
		frontmatter.push(`model: ${request.model}`);
	}
	if (request.maxTurns !== undefined) frontmatter.push(`maxTurns: ${request.maxTurns}`);
	if (request.maxTokens !== undefined) frontmatter.push(`maxTokens: ${request.maxTokens}`);
	if (request.timeoutMs !== undefined) frontmatter.push(`timeoutMs: ${request.timeoutMs}`);
	if (request.thinking) frontmatter.push(`thinking: ${request.thinking}`);
	return ["---", ...frontmatter, "---", "", request.instructions.trim(), ""].join("\n");
}

/**
 * Create a definition file. Project scope is the default so definitions stay
 * with the repository; user scope requires an explicit request. Existing
 * definitions are never replaced unless asked, and generated text is validated
 * with the same parser discovery uses.
 */
export function createAgentDefinition(request: CreateDefinitionRequest): CreateDefinitionResult {
	const name = request.name.trim();
	if (name === "" || name === "." || name === "..") {
		return { ok: false, error: `Invalid agent name "${request.name}".` };
	}
	if (/[\/]/.test(name)) {
		return { ok: false, error: `Invalid agent name "${name}": it must not contain path separators.` };
	}
	if (request.description.trim() === "") {
		return { ok: false, error: 'A definition needs a non-empty "description".' };
	}
	if (request.instructions.trim() === "") {
		return { ok: false, error: 'A definition needs non-empty instructions for the agent body.' };
	}

	for (const key of ["maxTurns", "maxTokens", "timeoutMs"] as const) {
		const value = request[key];
		if (value === undefined) continue;
		if (!Number.isInteger(value) || value < 1) {
			return { ok: false, error: `"${key}" must be a positive integer (got ${value}).` };
		}
	}
	if (request.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(request.thinking)) {
		return {
			ok: false,
			error: `"thinking" must be one of: ${THINKING_LEVELS.join(", ")} (got "${request.thinking}").`,
		};
	}

	const availableTools = request.validation?.availableTools;
	if (request.tools) {
		for (const tool of request.tools) {
			if (tool === "task") {
				return {
					ok: false,
					error: 'An agent cannot be given the "task" tool: subagents never delegate further.',
				};
			}
			if (availableTools && !availableTools.includes(tool)) {
				return {
					ok: false,
					error: `Unknown tool "${tool}" in "tools": it is not registered in this session.`,
				};
			}
		}
	}
	if (request.model && request.validation?.modelExists && !request.validation.modelExists(request.model)) {
		return {
			ok: false,
			error: `Unknown model "${request.model}": it cannot be resolved against the current model registry.`,
		};
	}

	const scope: AgentScope = request.scope ?? "project";
	const dir =
		scope === "user"
			? agentsDirFor(request.cwd, request.agentDir, "user")
			: (request.projectAgentsDir ?? resolveProjectAgentsDir(request.cwd));
	const path = join(dir, `${slugFor(name)}.md`);
	const file = `${slugFor(name)}.md`;

	const rendered = renderAgentMarkdown({
		name,
		description: request.description.trim(),
		instructions: request.instructions,
		tools: request.tools,
		model: request.model?.trim() || undefined,
		maxTurns: request.maxTurns,
		maxTokens: request.maxTokens,
		timeoutMs: request.timeoutMs,
		thinking: request.thinking,
	});
	const parsed = parseAgentText(rendered, file, scope);
	if (!parsed.ok) {
		return { ok: false, error: `Generated definition is invalid: ${parsed.error.message}` };
	}

	if (existsSync(path) && !request.overwrite) {
		return {
			ok: false,
			error: `An agent definition already exists at ${path}. Set overwrite: true to replace it.`,
		};
	}

	const existing = discoverAgentsIn(dir, scope).agents.find(
		(agent) => agent.name === name && agent.file !== file,
	);
	if (existing && !request.overwrite) {
		return {
			ok: false,
			error: `An agent named "${name}" is already defined in ${existing.file} (${path}). Set overwrite: true to replace it.`,
		};
	}

	mkdirSync(dir, { recursive: true });
	writeFileSync(path, rendered, "utf-8");

	const shadowedUser =
		scope === "project" &&
		discoverAgentsIn(agentsDirFor(request.cwd, request.agentDir, "user"), "user").agents.some(
			(agent) => agent.name === name,
		);

	return { ok: true, path, scope, shadowedUser };
}
