/**
 * The one definition of a valid budget value, shared by everything that accepts
 * a number from a model, a file, or settings.
 *
 * Leaf module: it imports nothing, so the three callers (limits, agents,
 * settings) can each keep their own policy — throw, return an error, fall back —
 * without depending on each other.
 */
export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
