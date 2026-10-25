/**
 * Manual-test RPC driver for pi-neo-subagents.
 *
 * Spawns real `pi --mode rpc` with the extension loaded, sends a sequence of
 * prompts (each may be a `/subagents ...` command), and prints a readable
 * transcript of what a UI client would observe.
 *
 * Usage: node rpc-drive.mjs '<json array of prompts>'
 *
 * Environment:
 *   PI_LAUNCHER    path to pi-launcher.js (default: ~/.pi/agent/bin/pi-launcher.js)
 *   RPC_EXTENSION  extension entry to load (default: index.ts at the repo root)
 *   RPC_CWD        working directory the scenario runs in (default: fixtures/project)
 *   RPC_MODEL      provider/model to use
 *   RPC_APPROVE    set to pass --approve (project trust)
 *   RPC_NO_EXT     set to skip loading the extension (e.g. it is installed already)
 *   RPC_TIMEOUT    per-wait timeout in ms (default 180000)
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_LAUNCHER = join(homedir(), ".pi", "agent", "bin", "pi-launcher.js");
const LAUNCHER = process.env.PI_LAUNCHER ?? DEFAULT_LAUNCHER;
const EXTENSION = process.env.RPC_EXTENSION ?? join(REPO_ROOT, "index.ts");
const CWD = process.env.RPC_CWD ?? join(HERE, "fixtures", "project");

if (!existsSync(LAUNCHER)) {
	console.error(`Cannot find pi's launcher at ${LAUNCHER}.\nSet PI_LAUNCHER to the path of pi-launcher.js.`);
	process.exit(2);
}

const prompts = JSON.parse(process.argv[2] ?? "[]");

const child = spawn(
	process.execPath,
	[LAUNCHER, "--mode", "rpc", "--no-session", "--no-mcp", ...(process.env.RPC_APPROVE ? ["--approve"] : []), ...(process.env.RPC_NO_EXT ? [] : ["-e", EXTENSION]), ...(process.env.RPC_MODEL ? ["--model", process.env.RPC_MODEL] : [])],
	{ cwd: CWD, env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: ["pipe", "pipe", "pipe"] },
);

const pending = new Map();
const waiters = [];
let stderrText = "";

function emit(record) {
	for (let i = 0; i < waiters.length; i += 1) {
		if (waiters[i].match(record)) {
			const [waiter] = waiters.splice(i, 1);
			waiter.resolve(record);
			return;
		}
	}
}

function waitFor(match, timeoutMs = Number(process.env.RPC_TIMEOUT ?? 180_000)) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout waiting for record")), timeoutMs);
		waiters.push({
			match,
			resolve: (record) => {
				clearTimeout(timer);
				resolve(record);
			},
		});
	});
}

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			console.log(`[unparsed stdout] ${line}`);
			continue;
		}
		render(record);
		emit(record);
	}
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderrText += chunk;
});

function shorten(text, limit = 400) {
	const value = typeof text === "string" ? text : JSON.stringify(text);
	return value.length > limit ? `${value.slice(0, limit)}… [${value.length} chars]` : value;
}

function render(record) {
	switch (record.type) {
		case "extension_ui_request":
			if (record.method === "notify") {
				const message = String(record.message ?? "");
				console.log(`\n>>> NOTIFY [${record.notifyType ?? "info"}] (${message.length} chars):\n${shorten(message, 1500)}`);
				if (message.length > 1500) console.log(`--- notify tail ---\n${message.slice(-700)}`);
				console.log("");
			} else {
				console.log(`\n>>> UI ${record.method}:`, shorten(record, 400));
				const answer = { type: "extension_ui_response", id: record.id };
				const reply = (payload) => {
					child.stdin.write(JSON.stringify(payload) + "\n", (error) => {
						console.log(
							error ? `[driver] answer failed: ${error.message}` : `[driver] answered ${record.method}`,
						);
					});
				};
				if (record.method === "confirm") reply({ ...answer, confirmed: process.env.RPC_CONFIRM !== "false" });
				else if (record.method === "select") reply({ ...answer, value: record.options?.[0] });
				else if (record.method === "input" || record.method === "editor") reply({ ...answer, cancelled: true });
			}
			break;
		case "message_end": {
			const message = record.message ?? {};
			if (message.role === "assistant") {
				for (const part of message.content ?? []) {
					if (part.type === "text" && part.text?.trim()) console.log(`--- assistant: ${shorten(part.text, 1200)}`);
					if (part.type === "toolCall") console.log(`--- assistant calls ${part.name}(${shorten(part.arguments, 300)})`);
				}
			}
			if (message.role === "toolResult") {
				console.log(`--- toolResult [${message.toolName}] isError=${message.isError}: ${shorten(message.content, 800)}`);
			}
			if (message.role === "user") console.log(`--- user: ${shorten(message.content, 400)}`);
			break;
		}
		case "tool_execution_start":
			console.log(`--- tool ${record.toolName} START ${shorten(record.args, 300)}`);
			break;
		case "tool_execution_update":
			console.log(`--- tool ${record.toolName} UPDATE ${shorten(record.partialResult, 300)}`);
			break;
		case "tool_execution_end":
			console.log(`--- tool ${record.toolName} END isError=${record.isError} ${record.durationMs ?? "?"}ms${record.result?.details ? ` details=${shorten(record.result.details, 300)}` : ""}${record.result?.usage ? ` usage=${shorten(record.result.usage, 200)}` : ""}`);
			break;
		case "response":
			if (!record.success) console.log(`\n!!! response error for ${record.command}: ${record.error}`);
			else console.log(`\n[response] ${record.command} ok${record.data ? " " + shorten(record.data, 200) : ""}`);
			break;
		case "extension_error":
			console.log(`\n!!! EXTENSION ERROR: ${shorten(record, 800)}`);
			break;
		case "agent_settled":
			console.log("\n[agent settled]");
			break;
	}
}

let nextId = 1;
function send(command) {
	child.stdin.write(`${JSON.stringify({ id: `req-${nextId++}`, ...command })}\n`);
}

let sawAgentStart = false;
const originalRender = render;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	await sleep(1500); // let the extension load / session start
	for (const prompt of prompts) {
		// Driver directives (not sent to pi).
		if (typeof prompt === "string" && prompt.startsWith("STATS:")) {
			const waiter = waitFor((record) => record.type === "response" && record.command === "get_session_stats");
			send({ type: "get_session_stats" });
			const statsResponse = await waiter;
			console.log(`\n[driver] stats: ${shorten(statsResponse.data, 700)}`);
			continue;
		}
		if (typeof prompt === "string" && prompt.startsWith("WRITE:")) {
			// WRITE:<relative path>::<content> — driver-side file creation.
			const rest = prompt.slice("WRITE:".length);
			const separator = rest.indexOf("::");
			const relative = rest.slice(0, separator);
			const content = rest.slice(separator + 2);
			const target = join(CWD, relative);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
			console.log(`\n[driver] wrote ${relative} (${content.length} bytes)`);
			continue;
		}
		if (typeof prompt === "string" && prompt.startsWith("REMOVE:")) {
			const relative = prompt.slice("REMOVE:".length);
			const target = join(CWD, relative);
			try {
				const { rmSync } = await import("node:fs");
				rmSync(target);
				console.log(`\n[driver] removed ${relative}`);
			} catch (error) {
				console.log(`\n[driver] remove failed: ${error.message}`);
			}
			continue;
		}
		if (typeof prompt === "string" && prompt.startsWith("SHELL:")) {
			const command = prompt.slice("SHELL:".length);
			console.log(`\n[driver] shell: ${command}`);
			try {
				console.log(execSync(command, { cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
			} catch (error) {
				console.log(`[driver] shell failed: ${error.message}`);
			}
			continue;
		}
		const abortAfterMs = typeof prompt === "object" && prompt?.abortAfterMs;
		const text = typeof prompt === "string" ? prompt : prompt.text;
		const id = `req-${nextId}`;
		const responseWaiter = waitFor((record) => record.type === "response" && record.id === id);
		console.log(`\n================ PROMPT: ${text} ================`);
		send({ type: "prompt", message: text });
		if (abortAfterMs) {
			await sleep(abortAfterMs);
			console.log(`[driver] abort after ${abortAfterMs}ms`);
			send({ type: "abort" });
		}
		const response = await responseWaiter;
		const disposition = response.data?.disposition;
		console.log(`[disposition] ${disposition}`);
		if (disposition === "started") {
			await waitFor((record) => record.type === "agent_settled", Number(process.env.RPC_SETTLE ?? 240_000));
		} else {
			// A command reported "handled" (no run started) — but a handler may still
			// have kicked off a run (e.g. via sendUserMessage). Wait for a settle if
			// any run actually started, so the transcript captures it.
			await sleep(1500);
			const stateWaiter = waitFor((record) => record.type === "response" && record.command === "get_state");
			send({ type: "get_state" });
			const current = await stateWaiter;
			if (current.data?.isStreaming) {
				console.log("[note] command was reported as handled, but a run is in progress");
				await waitFor((record) => record.type === "agent_settled", Number(process.env.RPC_SETTLE ?? 240_000));
			}
		}
		await sleep(300);
	}
	const state = waitFor((record) => record.type === "response" && record.command === "get_state");
	send({ type: "get_state" });
	const stateResponse = await state;
	console.log("\n[final state]", shorten(stateResponse.data, 600));
} catch (error) {
	console.log(`\n!!! DRIVER ERROR: ${error.message}`);
	console.log("--- stderr ---\n" + stderrText.slice(-3000));
} finally {
	child.kill();
	await sleep(300);
	if (stderrText.trim()) console.log("\n--- stderr (tail) ---\n" + stderrText.slice(-2000));
	process.exit(0);
}
