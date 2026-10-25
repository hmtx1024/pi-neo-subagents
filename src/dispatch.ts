/**
 * Fan-out dispatch: run several delegations with bounded concurrency while
 * preserving submission order, per-task outcomes, and cancellation.
 *
 * Internal module — tests observe it only through the `task` tool.
 */

import type { Model, Usage } from "@earendil-works/pi-ai";

import {
	AD_HOC_AGENT_NAME,
	delegationTarget,
	delegateTask,
	identityOf,
	type DelegationRequest,
	type DelegationLimits,
	type DelegationRegistry,
	type TaskDetails,
} from "./delegate.ts";
import { combineUsage } from "./runner.ts";

/** Environment knob for the fan-out cap (documented in the README). */
export const CONCURRENCY_ENV = "PI_NEO_SUBAGENTS_MAX_CONCURRENCY";
export const DEFAULT_CONCURRENCY = 4;

export type TaskStatus = "ok" | "budget-stop" | "failed" | "skipped";

export interface DispatchTask {
	/** Named definition, or undefined for an ad-hoc entry. */
	agent?: string;
	/** Inline instructions for an ad-hoc entry. */
	instructions?: string;
	tools?: string[];
	model?: string;
	task: string;
	limits?: DelegationLimits;
}

export interface TaskOutcome {
	/** Position in the submitted list; results are returned in this order. */
	index: number;
	agent: string;
	task: string;
	status: TaskStatus;
	/** Raw reply, used for the chain placeholder. */
	reply?: string;
	resultText?: string;
	details?: TaskDetails;
	error?: string;
	usage?: Usage;
}

export interface ParallelRequest {
	cwd: string;
	registry: DelegationRegistry;
	hostModel: Model<any> | undefined;
	tasks: readonly DispatchTask[];
	signal?: AbortSignal;
	concurrency?: number;
	/** Called for each turn of each task, identifying which task progressed. */
	onProgress?: (index: number, agent: string, details: TaskDetails) => void;
	/** Accounting hook, forwarded so every level is recorded once. */
	onRun?: DelegationRequest["onRun"];
	/** Live activity, tagged with the task it belongs to. */
	onActivity?: (index: number, agent: string, activity: { turn: number; tool: string }) => void;
	/** Called once a task has settled (finished, failed, or skipped). */
	onSettled?: (index: number) => void;
	/** Delegation depth for these tasks (fan-out keeps the caller's depth). */
	depth?: number;
	/** Depth limit for nested delegations. */
	maxDepth?: number;
}

/** Resolve the fan-out cap, falling back to the default on missing/invalid values. */
export function resolveConcurrency(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[CONCURRENCY_ENV] ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
}

/**
 * Bounded-concurrency map. Workers pull the next index, so every item runs
 * exactly once, no item starves, and results stay in submission order.
 */
export async function runWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

/** Run every task; a failing task is an outcome, never an exception that cancels its siblings. */
export async function dispatchParallel(request: ParallelRequest): Promise<TaskOutcome[]> {
	const limit = request.concurrency ?? resolveConcurrency();
	return runWithConcurrency(request.tasks, limit, async (task, index) => {
		try {
			const outcome = await delegateTask({
				cwd: request.cwd,
				registry: request.registry,
				hostModel: request.hostModel,
				...delegationTarget(task),
				task: task.task,
				limits: task.limits,
				signal: request.signal,
				...(request.depth !== undefined ? { depth: request.depth } : {}),
				...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
				...(request.onRun ? { onRun: request.onRun } : {}),
				onProgress: (details) => request.onProgress?.(index, identityOf(task), details),
				onActivity: (activity) => request.onActivity?.(index, identityOf(task), activity),
			});
			return {
				index,
				agent: identityOf(task),
				task: task.task,
				status: outcome.details.budgetStop ? "budget-stop" : "ok",
				reply: outcome.reply,
				resultText: outcome.resultText,
				details: outcome.details,
				usage: outcome.usage,
			} satisfies TaskOutcome;
		} catch (error) {
			return {
				index,
				agent: identityOf(task),
				task: task.task,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			} satisfies TaskOutcome;
		} finally {
			request.onSettled?.(index);
		}
	});
}

/** Combined usage of every task that produced one. */
export function totalUsage(outcomes: readonly TaskOutcome[]): Usage {
	return combineUsage(outcomes.map((outcome) => outcome.usage).filter((usage): usage is Usage => usage !== undefined));
}

/** Placeholder a chain step uses to consume the previous step's reply. */
export const PREVIOUS_PLACEHOLDER = "{previous}";

export interface ChainRequest extends Omit<ParallelRequest, "tasks"> {
	steps: readonly DispatchTask[];
}

/**
 * Run steps strictly in order, substituting the previous reply. The chain stops
 * at the first step that does not complete (failure or budget stop) and marks
 * the remaining steps as skipped so the caller sees the whole pipeline.
 */
export async function dispatchChain(request: ChainRequest): Promise<TaskOutcome[]> {
	const { steps } = request;
	if (steps.length === 0) {
		throw new Error("A chain needs at least one step.");
	}
	if (steps[0].task.includes(PREVIOUS_PLACEHOLDER)) {
		throw new Error(
			`The first step cannot use ${PREVIOUS_PLACEHOLDER}: there is no previous reply to substitute.`,
		);
	}

	const outcomes: TaskOutcome[] = [];
	let previousReply: string | undefined;

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index];
		const task =
			previousReply === undefined
				? step.task
				: step.task.split(PREVIOUS_PLACEHOLDER).join(previousReply);

		let outcome: TaskOutcome;
		try {
			const result = await delegateTask({
				cwd: request.cwd,
				registry: request.registry,
				hostModel: request.hostModel,
				...delegationTarget(step),
				task,
				limits: step.limits,
				signal: request.signal,
				...(request.depth !== undefined ? { depth: request.depth } : {}),
				...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
				...(request.onRun ? { onRun: request.onRun } : {}),
				onProgress: (details) => request.onProgress?.(index, identityOf(step), details),
				onActivity: (activity) => request.onActivity?.(index, identityOf(step), activity),
			});
			outcome = {
				index,
				agent: identityOf(step),
				task,
				status: result.details.budgetStop ? "budget-stop" : "ok",
				reply: result.reply,
				resultText: result.resultText,
				details: result.details,
				usage: result.usage,
			};
		} catch (error) {
			outcome = {
				index,
				agent: identityOf(step),
				task,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		outcomes.push(outcome);

		if (outcome.status !== "ok") {
			for (let rest = index + 1; rest < steps.length; rest += 1) {
				outcomes.push({
					index: rest,
					agent: identityOf(steps[rest]),
					task: steps[rest].task,
					status: "skipped",
				});
			}
			break;
		}
		previousReply = outcome.reply ?? outcome.resultText ?? "";
	}

	return outcomes;
}
