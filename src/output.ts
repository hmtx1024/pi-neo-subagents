/**
 * Everything the user or the model sees as text: command output in every mode,
 * direct-run summaries, and per-task result blocks.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { writeFullResult, type DelegationOutcome } from "./delegate.ts";
import type { TaskOutcome } from "./dispatch.ts";

/** Locale-independent timestamp for listings. */
export function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** Characters of a direct-run result shown inline; the rest goes to a file. */
export const DISPLAY_LIMIT = 2_000;

/**
 * Deliver command output to the user in every mode. In print mode stdout is the
 * answer channel; in JSON mode stdout carries the protocol stream, so plain text
 * goes to stderr instead of corrupting it.
 */
export function present(
	ctx: ExtensionCommandContext,
	text: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	const stream = level === "info" && ctx.mode === "print" ? process.stdout : process.stderr;
	stream.write(`${text}\n`);
}

/** Direct-run result plus a one-line usage summary, capped for readability. */
export function formatDirectRun(name: string, outcome: DelegationOutcome): string {
	const { usage, details } = outcome;
	const turns = `${details.turns} turn${details.turns === 1 ? "" : "s"}`;
	const footer = `[${name} · ${details.model} · ${turns} · tokens ${usage.totalTokens} (in ${usage.input} / out ${usage.output}) · $${usage.cost.total.toFixed(6)}]`;
	if (outcome.resultText.length <= DISPLAY_LIMIT) {
		return `${outcome.resultText}\n\n${footer}`;
	}
	const path = outcome.fullResultPath ?? writeFullResult(outcome.reply);
	return `${outcome.resultText.slice(0, DISPLAY_LIMIT)}\n\n[Display truncated at ${DISPLAY_LIMIT} characters. Full result: ${path}]\n\n${footer}`;
}

/** One task per block, in submission order, with its own status. */
export function formatOutcomes(outcomes: readonly TaskOutcome[]): string {
	return outcomes
		.map((outcome) => {
			const total = outcomes.length;
			const label =
				outcome.status === "ok"
					? "ok"
					: outcome.status === "budget-stop"
						? `budget stop (${outcome.details?.budgetStop?.kind ?? "budget"})`
						: outcome.status === "skipped"
							? "skipped (an earlier step did not complete)"
							: "failed";
			const body = outcome.status === "failed" ? (outcome.error ?? "failed") : (outcome.resultText ?? "");
			return `[${outcome.index + 1}/${total}] ${outcome.agent} — ${label}\n${body}`;
		})
		.join("\n\n");
}

