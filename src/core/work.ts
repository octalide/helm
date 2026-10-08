import type { ReportState, Work } from './types.ts';

// reports by which a session claims work for its own main loop
const SELF: ReadonlySet<ReportState> = new Set(['working', 'waiting', 'ready']);

// whether the owner session's own main loop is the worker: no agent, and the session claimed it by reporting
export function selfWorked(w: Work): boolean {
  return w.agent === undefined && w.report !== undefined && SELF.has(w.report.state);
}

// whether anything is on the work: an agent, or its owner session itself
export function hasWorker(w: Work): boolean {
  return w.agent !== undefined || selfWorked(w);
}
