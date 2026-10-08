import { describe, expect, it } from 'vitest';
import type { Decision, Fleet, Session, WorkView } from '../src/core/types.ts';
import { bandRow, paneRows, statusText } from '../src/mod/view.ts';
import { T0 } from './fixtures.ts';

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, role: 'repo', cwd: '/', agents: [], startedAt: T0, seenAt: T0, ...over });
const work = (issue: number, phase: WorkView['phase'], owner = 'S'): WorkView => ({ repo: 'o/r', issue, title: `t${issue}`, owner, order: issue, queuedAt: T0, updatedAt: T0, phase, verdict: 'none', checks: [], jobs: [], decisions: 0 });
const decision = (id: string, blocking: boolean, issue: number): Decision => ({ id, kind: blocking ? 'question' : 'routing', repo: 'o/r', issue, title: `q${id}`, body: '', blocking, state: 'open', createdAt: T0, updatedAt: T0 });
const fleet = (over: Partial<Fleet>): Fleet => ({ version: '0', sessions: [session('S'), session('B')], work: [], decisions: [], subscriptions: [], repos: {}, tree: [], rates: {}, at: T0, ...over });
const text = (rows: { text: string }[][]) => rows.map((r) => r.map((s) => s.text).join(''));

describe('view', () => {
  it('lists the session\'s own work, what needs someone first', () => {
    const f = fleet({ work: [work(1, 'queued'), work(2, 'blocked'), work(3, 'ci'), work(4, 'working', 'B')], decisions: [decision('d1', true, 2)] });
    const rows = text(paneRows(f, { session: 'S', role: 'repo' }, 40));
    expect(rows[0]).toBe('2 active · 1 queued · 1 in ci · 1 need attention · 1 waiting on a decision');
    expect(rows.filter((r) => /^\w+\s+#\d/.test(r)).map((r) => r.split(' ')[0])).toEqual(['blocked', 'ci', 'queued']);
    expect(rows).toContain('d1   waiting r#2 qd1 · 0s');
  });

  it('groups the fleet by session for a coordinator', () => {
    const f = fleet({ sessions: [session('C', { role: 'coordinator' }), session('S', { repo: 'o/r' })], work: [work(1, 'working')] });
    const rows = text(paneRows(f, { session: 'C', role: 'coordinator' }, 40));
    expect(rows).toContain('o/r repo · 0 agents running');
  });

  it('shows the band and status only when there is something to show', () => {
    expect(bandRow(fleet({ work: [work(1, 'working')] }), { session: 'S', role: 'repo' })).toBeUndefined();
    expect(text([bandRow(fleet({ work: [work(1, 'failing')] }), { session: 'S', role: 'repo' })!])[0]).toBe('helm 1 active · 1 need attention');
    expect(statusText(fleet({}), { session: 'S', role: 'repo' })).toBeUndefined();
    expect(statusText(fleet({ work: [work(1, 'ci'), work(2, 'working')] }), { session: 'S', role: 'repo' })).toBe('helm 2▸ 1ci');
  });

  it('cuts to the room it has', () => {
    const f = fleet({ work: Array.from({ length: 30 }, (_, i) => work(i + 1, 'queued')) });
    const rows = text(paneRows(f, { session: 'S', role: 'repo' }, 10));
    expect(rows.length).toBe(10);
    expect(rows[9]).toMatch(/^… \d+ more rows$/);
  });
});
