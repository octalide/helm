import type { Check, CheckState, Verdict } from './types.ts';

const PASSING: ReadonlySet<CheckState> = new Set(['success', 'skipped', 'neutral']);

export function isDone(state: CheckState): boolean {
  return state !== 'queued' && state !== 'running';
}

export function isPassing(state: CheckState): boolean {
  return PASSING.has(state);
}

// the aggregate over every check on a head: pending until the last finishes, then whether all of them pass
export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => !isDone(c.state))) return 'pending';
  return checks.every((c) => isPassing(c.state)) ? 'success' : 'failure';
}
