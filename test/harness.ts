/**
 * Test harness: the pre-agreed seam for this project.
 *
 * Every test drives a full in-memory agent session created through the Pi SDK
 * (`createAgentSession`) with:
 *   - a scripted fake model (pi-ai's `fauxProvider`, a system-boundary stub),
 *   - in-memory session storage and throwaway config directories,
 *   - the real extension entry point loaded through Pi's normal extension
 *     loading path (jiti, no build step),
 *   - a recording UI context injected via `bindExtensions`, so command output
 *     ("what the user sees") is observable at the same boundary.
 *
 * Tests assert only behaviour visible at this boundary: tool results, visible
 * session messages, recorded UI output, and what the model sees. Never reach
 * into internals.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

export interface RecordedNotification {
	message: string;
	type: "info" | "warning" | "error";
}

export interface RecordedStatus {
	key: string;
	text: string | undefined;
}

export interface RecordingUI {
	notifications: RecordedNotification[];
	statuses: RecordedStatus[];
	/** Dialog methods that were called, in order (so "never asked" is assertable). */
	dialogCalls: Array<{ method: "input" | "confirm" | "editor"; title?: string }>;
	/** Widget updates, in order; `lines: undefined` means the widget was cleared. */
	widgets: Array<{ key: string; lines: string[] | undefined }>;
	ui: ExtensionUIContext;
}

/** Scripted answers for dialog methods; each call shifts the next value. */
export interface ScriptedDialogs {
	input?: Array<string | undefined>;
	confirm?: Array<boolean | undefined>;
	editor?: Array<string | undefined>;
}

/**
 * Records user-facing output; dialog methods answer from the script. Unscripted
 * confirmations answer "yes" (a user who is offered the choice consents), while
 * unscripted inputs/editors answer "cancelled".
 */
export function createRecordingUI(dialogs?: ScriptedDialogs): RecordingUI {
	const notifications: RecordedNotification[] = [];
	const statuses: RecordedStatus[] = [];
	const dialogCalls: RecordingUI["dialogCalls"] = [];
	const widgets: RecordingUI["widgets"] = [];
	const ui = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type: type ?? "info" });
		},
		setStatus(key: string, text: string | undefined) {
			statuses.push({ key, text });
		},
		async input(title?: string) {
			dialogCalls.push({ method: "input", title });
			return dialogs?.input?.shift();
		},
		async confirm(title?: string) {
			dialogCalls.push({ method: "confirm", title });
			return dialogs?.confirm?.shift() ?? true;
		},
		async editor(title?: string) {
			dialogCalls.push({ method: "editor", title });
			return dialogs?.editor?.shift();
		},
		setWidget(key: string, content: string[] | undefined) {
			widgets.push({ key, lines: Array.isArray(content) ? [...content] : undefined });
		},
	} as unknown as ExtensionUIContext;
	return { notifications, statuses, dialogCalls, widgets, ui };
}

/**
 * Capture process stdout/stderr for the duration of a test, so the
 * non-interactive output channels (`--print`, `--mode json`) are observable.
 */
export function captureStdio(): { stdout(): string; stderr(): string; restore(): void } {
	let out = "";
	let err = "";
	const stdoutWrite = process.stdout.write.bind(process.stdout);
	const stderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: unknown) => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => out,
		stderr: () => err,
		restore() {
			process.stdout.write = stdoutWrite;
			process.stderr.write = stderrWrite;
		},
	};
}

export interface TestSession {
	session: AgentSession;
	faux: FauxProviderHandle;
	ui: RecordingUI;
	/** Session working directory (the temp root, or its `subdir`). */
	cwd: string;
	/** Temp root for this test. */
	root: string;
	/** User agent directory for this test (user-level agent definitions live here). */
	agentDir: string;
	dispose(): void;
}

export interface TestSessionOptions {
	/** Extension mode reported to the extension (default: the SDK's default). */
	mode?: "tui" | "rpc" | "json" | "print";
	/** Populate the throwaway directories before the session is created. */
	setup?: (dirs: { cwd: string; agentDir: string }) => void;
	/** Run the session from this subdirectory of the temp root (discovery walk tests). */
	subdir?: string;
	/** Scripted dialog answers (input/confirm/editor). */
	dialogs?: ScriptedDialogs;
	/** Extra extension files loaded alongside the plugin (host-side extension tools). */
	extraExtensionPaths?: string[];
}

export async function createTestSession(options?: TestSessionOptions): Promise<TestSession> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-neo-subagents-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-neo-subagents-agent-"));
	// Point pi's user-level agent directory at the throwaway directory so user-level
	// resource discovery is hermetic (same knob pi itself honours).
	process.env.PI_CODING_AGENT_DIR = agentDir;
	options?.setup?.({ cwd, agentDir });
	const root = cwd;
	const sessionCwd = options?.subdir ? join(cwd, options.subdir) : cwd;
	if (options?.subdir) mkdirSync(sessionCwd, { recursive: true });

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});

	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", name: "Faux 1", reasoning: true },
			{ id: "faux-2", name: "Faux 2", reasoning: true },
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);

	const resourceLoader = new DefaultResourceLoader({
		cwd: sessionCwd,
		agentDir,
		additionalExtensionPaths: [EXTENSION_PATH, ...(options?.extraExtensionPaths ?? [])],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: sessionCwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		sessionManager: SessionManager.inMemory(sessionCwd),
		resourceLoader,
	});

	const ui = createRecordingUI(options?.dialogs);
	// Real print/JSON sessions have no UI context at all (`hasUI === false`,
	// `ctx.ui.*` is a no-op), so the harness must not inject one either.
	const hasUI = options?.mode === undefined || options?.mode === "tui" || options?.mode === "rpc";
	await session.bindExtensions(
		hasUI ? { uiContext: ui.ui, mode: options?.mode } : { mode: options?.mode },
	);

	return {
		session,
		faux,
		ui,
		cwd: sessionCwd,
		root,
		agentDir,
		dispose() {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

/** Text of a tool-result message as the model sees it. */
export function toolResultText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

/** Everything the user saw, concatenated — the seam's view of command output. */
export function userOutput(ui: RecordingUI): string {
	return ui.notifications.map((notification) => notification.message).join("\n");
}
