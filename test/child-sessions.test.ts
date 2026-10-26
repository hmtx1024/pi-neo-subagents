/**
 * Ticket 12 (slice B) — a delegation's nested session becomes a real session.
 *
 * The subagent's transcript used to be thrown away (`SessionManager.inMemory`).
 * Now, when the HOST session has a file, the child gets its own file in the same
 * session directory, named `↳ <agent> · <time>` and linked to the host by
 * `parentSession`. Replay is then pi's own session browser — no replay UI, no
 * second format.
 *
 * When the host has no file (in-memory sessions), nothing is written: persistence
 * mirrors the host's own persistence, so no configuration knob is needed.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession } from "./harness.ts";

function writeAgent(root: string, name: string, frontmatter: string[] = []): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `description: The ${name} agent`, ...frontmatter, "---", "", "Body.", ""].join("\n"),
	);
}

interface SessionHeaderLike {
	type: string;
	id: string;
	parentSession?: string;
	cwd: string;
}

/** Every session file in a directory, header parsed. */
function sessionFiles(dir: string): Array<{ path: string; header: SessionHeaderLike; entries: unknown[] }> {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => {
			const path = join(dir, file);
			const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
			return {
				path,
				header: JSON.parse(lines[0]) as SessionHeaderLike,
				entries: lines.slice(1).map((line) => JSON.parse(line)),
			};
		});
}

function delegation(agent: string, task = "Do it.") {
	return fauxAssistantMessage(fauxToolCall("task", { agent, task }), { stopReason: "toolUse" });
}

it("writes the subagent's transcript as a child session linked to the host", async () => {
	const { session, faux, root, sessionDir, dispose } = await createTestSession({ persistSession: true });
	try {
		writeAgent(root, "reviewer");
		faux.setResponses([delegation("reviewer"), fauxAssistantMessage("reviewed it"), fauxAssistantMessage("done")]);

		await session.prompt("Delegate.");

		const hostFile = (session.sessionManager as unknown as { getSessionFile(): string }).getSessionFile();
		const files = sessionFiles(sessionDir);
		const children = files.filter((file) => file.header.parentSession === hostFile);
		expect(children).toHaveLength(1);

		const child = children[0];
		// The transcript is really there: the task text made it to disk.
		expect(JSON.stringify(child.entries)).toContain("Do it.");
		expect(JSON.stringify(child.entries)).toContain("reviewed it");
		// Named so pi's own session browser shows what it is.
		const info = child.entries.find((entry) => (entry as { type?: string }).type === "session_info") as
			| { name?: string }
			| undefined;
		expect(info?.name).toMatch(/^↳ reviewer · /);
	} finally {
		dispose();
	}
});

it("writes nothing when the host session itself is not persisted", async () => {
	const { session, faux, root, sessionDir, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer");
		faux.setResponses([delegation("reviewer"), fauxAssistantMessage("reviewed it"), fauxAssistantMessage("done")]);

		await session.prompt("Delegate.");

		const files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
		expect(files).toHaveLength(0);
	} finally {
		dispose();
	}
});

it("persists children of parallel and chained dispatches too", async () => {
	const { session, faux, root, sessionDir, dispose } = await createTestSession({ persistSession: true });
	try {
		writeAgent(root, "one");
		writeAgent(root, "two");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [
						{ agent: "one", task: "first" },
						{ agent: "two", task: "second" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("one done"),
			fauxAssistantMessage("two done"),
			fauxAssistantMessage(
				fauxToolCall("task", {
					chain: [
						{ agent: "one", task: "third" },
						{ agent: "two", task: "fourth {previous}" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("third done"),
			fauxAssistantMessage("fourth done"),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Fan out.");
		await session.prompt("Chain.");

		const hostFile = (session.sessionManager as unknown as { getSessionFile(): string }).getSessionFile();
		const children = sessionFiles(sessionDir).filter((file) => file.header.parentSession === hostFile);
		expect(children).toHaveLength(4);
	} finally {
		dispose();
	}
});

it("records the child session id in the ledger entry", async () => {
	const { session, faux, root, sessionDir, dispose } = await createTestSession({ persistSession: true });
	try {
		writeAgent(root, "reviewer");
		faux.setResponses([delegation("reviewer"), fauxAssistantMessage("reviewed it"), fauxAssistantMessage("done")]);

		await session.prompt("Delegate.");

		const entries = (session.sessionManager as unknown as { getEntries(): unknown[] }).getEntries();
		const run = entries.find(
			(entry) => (entry as { customType?: string }).customType === "pi-neo-subagents/run",
		) as { data?: { sessionId?: string } } | undefined;
		expect(run?.data?.sessionId).toBeTruthy();

		const hostFile = (session.sessionManager as unknown as { getSessionFile(): string }).getSessionFile();
		const child = sessionFiles(sessionDir).find((file) => file.header.parentSession === hostFile);
		expect(run?.data?.sessionId).toBe(child?.header.id);
	} finally {
		dispose();
	}
});
