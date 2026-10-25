/**
 * Live-model smoke suite (ticket 12).
 *
 * The hermetic suite drives a scripted model, so it cannot see whether real
 * models follow the delegation guidance. This suite runs the real path against a
 * cheap real model and asserts what a user would end up with on disk.
 *
 * It is never part of the default run: run it with `npm run test:live`.
 * Requires provider credentials in Pi's agent directory (the same ones `pi` uses).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	getAgentDir,
	type AgentSession,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import { EXTENSION_PATH } from "../harness.ts";

const ENABLED = process.env.PI_NEO_SUBAGENTS_LIVE === "1";
const MODEL_SPEC = process.env.PI_NEO_SUBAGENTS_LIVE_MODEL ?? "deepseek/deepseek-flash";

interface LiveSession {
	session: AgentSession;
	notifications: string[];
	dispose(): void;
}

/**
 * Build a real session (no fake model) with the extension loaded and a recording
 * UI, in a throwaway working directory. Credentials come from Pi's real agent
 * directory, which is what makes this suite live.
 */
async function createLiveSession(): Promise<LiveSession> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-neo-subagents-live-"));
	const agentDir = getAgentDir();
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const models = modelRuntime.getModels();
	const model =
		models.find((candidate) => `${candidate.provider}/${candidate.id}` === MODEL_SPEC) ??
		models.find((candidate) => candidate.id === MODEL_SPEC);

	if (!model) {
		throw new Error(
			`Live smoke suite: model "${MODEL_SPEC}" is not available. ` +
				`Set PI_NEO_SUBAGENTS_LIVE_MODEL to one of: ${models
					.slice(0, 12)
					.map((candidate) => `${candidate.provider}/${candidate.id}`)
					.join(", ")}`,
		);
	}
	if (!modelRuntime.getProvider(model.provider)) {
		throw new Error(
			`Live smoke suite: no credentials for provider "${model.provider}". ` +
				`Run \`pi auth\` (or configure ${join(agentDir, "auth.json")}) before running npm run test:live.`,
		);
	}

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [EXTENSION_PATH],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
	});

	const notifications: string[] = [];
	const ui = {
		notify(message: string) {
			notifications.push(message);
		},
		setStatus() {},
		async confirm() {
			return true;
		},
		async input() {
			return undefined;
		},
		async editor() {
			return undefined;
		},
		setWidget() {},
	} as unknown as ExtensionUIContext;
	await session.bindExtensions({ uiContext: ui, mode: "tui" });

	return {
		session,
		notifications,
		dispose() {
			session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function toolResults(session: AgentSession, toolName: string) {
	return session.messages.filter(
		(message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === toolName,
	) as unknown as Array<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe.skipIf(!ENABLED)("live smoke: zero definitions to delegation", () => {
	it("creates definitions in the project, fans out, and accounts for the runs", async () => {
		const live = await createLiveSession();
		try {
			const before = toolResults(live.session, "task").length;

			await live.session.prompt(
				"请用 create_subagent 在项目里创建两个 agent（name 用 py-dev 和 go-dev，都要能读写文件并运行命令）。" +
					"然后用 task 工具的 tasks 形状并行委派：py-dev 写并运行 hello.py（打印 Hello from Python），" +
					"go-dev 写并运行 hello.go（打印 Hello from Go）。",
			);

			const agentsDir = join(live.session.sessionManager.getCwd(), ".pi", "agents");
			expect(existsSync(agentsDir)).toBe(true);
			const definitions = readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
			expect(definitions.length).toBeGreaterThanOrEqual(2);

			const cwd = live.session.sessionManager.getCwd();
			expect(existsSync(join(cwd, "hello.py"))).toBe(true);
			expect(readFileSync(join(cwd, "hello.py"), "utf-8")).toContain("Hello");

			const delegations = toolResults(live.session, "task");
			expect(delegations.length).toBeGreaterThan(before);
			const text = delegations
				.slice(before)
				.map((result) => resultText(result))
				.join("\n");
			expect(text.trim().length).toBeGreaterThan(0);

			await live.session.prompt("/subagents stats");
			const stats = live.notifications.join("\n");
			expect(stats).toContain("py-dev");
			expect(stats).toContain("go-dev");
			expect(stats).toMatch(/\d+ runs?/);
		} finally {
			live.dispose();
		}
	}, 600_000);

	it("delegates ad-hoc without creating a definition", async () => {
		const live = await createLiveSession();
		try {
			await live.session.prompt(
				"用 task 工具的 instructions 字段内联委派一个一次性任务：创建一个 adhoc.txt，内容写 ad-hoc ok。" +
					"不要创建任何 agent 定义文件。",
			);

			const cwd = live.session.sessionManager.getCwd();
			expect(existsSync(join(cwd, "adhoc.txt"))).toBe(true);
			expect(existsSync(join(cwd, ".pi", "agents"))).toBe(false);

			await live.session.prompt("/subagents stats");
			expect(live.notifications.join("\n")).toContain("ad-hoc");
		} finally {
			live.dispose();
		}
	}, 600_000);
});
