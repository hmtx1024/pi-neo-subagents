/**
 * Per-session delegation ledger: what each agent cost, how it went, and how long
 * it took. In memory only — a ledger belongs to one session.
 *
 * Internal module — tests observe it through `/subagents stats`.
 */

import type { Usage } from "@earendil-works/pi-ai";

export type LedgerStatus = "ok" | "budget-stop" | "failed";

export interface LedgerRecord {
	agent: string;
	status: LedgerStatus;
	turns?: number;
	usage?: Usage;
	durationMs?: number;
	/** Depth the run executed at (host session = 0). */
	depth?: number;
}

export interface LedgerEntry {
	agent: string;
	runs: number;
	successes: number;
	failures: number;
	budgetStops: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	totalDurationMs: number;
	timedRuns: number;
	/** Deepest delegation observed for this agent. */
	maxDepth: number;
}

const EMPTY_ENTRY = (agent: string): LedgerEntry => ({
	agent,
	runs: 0,
	successes: 0,
	failures: 0,
	budgetStops: 0,
	turns: 0,
	inputTokens: 0,
	outputTokens: 0,
	cost: 0,
	totalDurationMs: 0,
	timedRuns: 0,
	maxDepth: 0,
});

export class RunLedger {
	private entriesByName = new Map<string, LedgerEntry>();

	record(record: LedgerRecord): void {
		const entry = this.entriesByName.get(record.agent) ?? EMPTY_ENTRY(record.agent);
		entry.runs += 1;
		if (record.status === "ok") entry.successes += 1;
		else if (record.status === "budget-stop") entry.budgetStops += 1;
		else entry.failures += 1;
		entry.turns += record.turns ?? 0;
		entry.inputTokens += record.usage?.input ?? 0;
		entry.outputTokens += record.usage?.output ?? 0;
		entry.cost += record.usage?.cost.total ?? 0;
		if (record.durationMs !== undefined) {
			entry.totalDurationMs += record.durationMs;
			entry.timedRuns += 1;
		}
		entry.maxDepth = Math.max(entry.maxDepth, record.depth ?? 0);
		this.entriesByName.set(record.agent, entry);
	}

	entries(): LedgerEntry[] {
		return [...this.entriesByName.values()].sort((left, right) => left.agent.localeCompare(right.agent));
	}

	get isEmpty(): boolean {
		return this.entriesByName.size === 0;
	}

	reset(): void {
		this.entriesByName.clear();
	}
}

function formatCount(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Human-readable ledger; one row per agent, plus a running total. */
export function formatLedger(ledger: RunLedger): string {
	const entries = ledger.entries();
	if (entries.length === 0) {
		return "No delegation runs recorded in this session yet.";
	}
	const lines = ["Delegation ledger (this session):"];
	for (const entry of entries) {
		const average = entry.timedRuns === 0 ? 0 : Math.round(entry.totalDurationMs / entry.timedRuns);
		lines.push(
			`- ${entry.agent}: ${formatCount(entry.runs, "run")}` +
				` (${entry.successes} ok, ${entry.failures} failed, ${entry.budgetStops} budget stop${entry.budgetStops === 1 ? "" : "s"})` +
				` · ${formatCount(entry.turns, "turn")}` +
				` · tokens ${entry.inputTokens} in / ${entry.outputTokens} out` +
				` · $${entry.cost.toFixed(6)}` +
				` · avg ${average}ms` +
				` · depth ${entry.maxDepth}`,
		);
	}
	const totalRuns = entries.reduce((sum, entry) => sum + entry.runs, 0);
	const totalCost = entries.reduce((sum, entry) => sum + entry.cost, 0);
	lines.push(`Total: ${formatCount(totalRuns, "run")} · $${totalCost.toFixed(6)}`);
	return lines.join("\n");
}
