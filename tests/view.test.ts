import { describe, expect, it } from 'vitest';
import type { Decision, Fleet, Run, Session, TreeNode, WorkView } from '../src/core/types.ts';
import { bandRow, bar, paneRows, type PaneOpts, type Row, statusText } from '../src/mod/view.ts';
import { T0 } from './fixtures.ts';

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, role: 'repo', cwd: '/', agents: [], startedAt: T0, seenAt: T0, ...over });
const work = (issue: number, phase: WorkView['phase'], owner = 'S', over: Partial<WorkView> = {}): WorkView => ({ repo: 'o/r', issue, title: `t${issue}`, owner, order: issue, queuedAt: T0, updatedAt: T0, phase, verdict: 'none', checks: [], jobs: [], decisions: 0, ...over });
const decision = (id: string, blocking: boolean, issue: number, over: Partial<Decision> = {}): Decision => ({ id, kind: blocking ? 'question' : 'routing', repo: 'o/r', issue, title: `q${id}`, body: '', blocking, state: 'open', createdAt: T0, updatedAt: T0, ...over });
const fleet = (over: Partial<Fleet>): Fleet => ({ version: '0', sessions: [session('S', { repo: 'o/r' }), session('B')], work: [], decisions: [], subscriptions: [], repos: {}, tree: [], rates: {}, at: T0, ...over });
const text = (rows: Row[]) => rows.map((r) => r.map((s) => s.text).join(''));
const opts = (over: Partial<PaneOpts> = {}): PaneOpts => ({ rows: 60, cols: 80, tab: 'work', ...over });
const self = { session: 'S', role: 'repo' as const, repo: 'o/r' };

describe('pane', () => {
  it('draws tabs as controls with hotkeys and badges', () => {
    const f = fleet({ work: [work(1, 'ci')], decisions: [decision('d1', true, 1)] });
    const tabs = paneRows(f, self, opts())[0]!.filter((s) => s.press);
    expect(tabs.map((s) => [s.press, s.hotkey, s.text])).toEqual([
      ['tab:work', '1', 'Work 1'],
      ['tab:epics', '2', 'Epics'],
      ['tab:ci', '3', 'CI'],
      ['tab:inbox', '4', 'Inbox 1'],
    ]);
  });

  it('lists the session\'s own work, what needs someone first, with plan and checks', () => {
    const plan = [{ text: 'a', done: true }, { text: 'b', done: false }];
    const f = fleet({ work: [work(1, 'queued'), work(2, 'blocked'), work(3, 'ci', 'S', { plan, checks: [{ name: 'test', state: 'running' }] }), work(4, 'working', 'B')], decisions: [decision('d1', true, 2)] });
    const rows = text(paneRows(f, self, opts()));
    expect(rows[2]).toBe('2 active · 1 queued · 1 in ci · 1 need attention · 1 waiting on a decision');
    expect(rows.filter((r) => /^. \w+\s+#\d/.test(r)).map((r) => r.split(/\s+/)[1])).toEqual(['blocked', 'ci', 'queued']);
    expect(rows).toContain('  ▰▰▱▱ 1/2 next: b');
    expect(rows.some((r) => r.startsWith('  ci ') && r.includes('0/1'))).toBe(true);
  });

  it('drops the detail line on a narrow pane and keeps bars inside it', () => {
    const f = fleet({ work: [work(1, 'working', 'S', { routing: { tier: 'deep', model: 'claude-opus-5-5', effort: 'high', by: 'judge', at: T0 } })] });
    const wide = text(paneRows(f, self, opts()));
    const narrow = text(paneRows(f, self, opts({ cols: 30 })));
    expect(wide.some((r) => r.includes('deep opus 5.5/high'))).toBe(true);
    expect(narrow.some((r) => r.includes('deep opus 5.5/high'))).toBe(false);
    expect(Math.max(...narrow.slice(2, 4).map((r) => r.length))).toBeLessThanOrEqual(30);
  });

  it('groups the fleet by session for a coordinator', () => {
    const f = fleet({ sessions: [session('C', { role: 'coordinator' }), session('S', { repo: 'o/r' })], work: [work(1, 'working')] });
    expect(text(paneRows(f, { session: 'C', role: 'coordinator' }, opts()))).toContain('r repo · 0 agents running');
  });

  it('shows epics touching the session with their rollup and what moves under them', () => {
    const leaf = (n: number, phase?: WorkView['phase']): TreeNode => ({ repo: 'o/r', number: n, title: `c${n}`, url: '', state: phase === 'done' ? 'closed' : 'open', ...(phase ? { phase } : {}), children: [], rollup: { total: 1, done: phase === 'done' ? 1 : 0, active: phase === 'working' ? 1 : 0, attention: 0, ci: 0, ready: 0, queued: 0, parked: 0, unowned: phase ? 0 : 1 } });
    const root: TreeNode = { ...leaf(9), title: 'epic: big', children: [leaf(1, 'done'), leaf(2, 'working'), leaf(3)], rollup: { total: 3, done: 1, active: 1, attention: 0, ci: 0, ready: 0, queued: 0, parked: 0, unowned: 1 } };
    const rows = text(paneRows(fleet({ tree: [root] }), self, opts({ tab: 'epics' })));
    expect(rows[2]).toBe(' 33% r#9 big');
    expect(rows[3]).toMatch(/^ {5}━+─+ 1\/3$/);
    expect(rows).toContain('     1 active · 1 unowned');
    expect(rows).toContain('     ● #2 c2');
  });

  it('shows runs in flight with their running steps, then recent ones', () => {
    const run = (id: number, state: Run['state'], jobs: Run['jobs'] = []): Run => ({ id, workflow: `wf${id}`, branch: 'dev', sha: 'a'.repeat(40), event: 'push', state, url: '', actor: 'x', createdAt: new Date(T0 - id * 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), jobs });
    const jobs = [{ id: 7, run: 1, name: 'build', state: 'running' as const, url: '', steps: [{ number: 1, name: 'setup', state: 'success' as const }, { number: 2, name: 'compile', state: 'running' as const }, { number: 3, name: 'test', state: 'queued' as const }] }];
    const rows = text(paneRows(fleet({ repos: { 'o/r': { polling: { active: true, interval: 20, failures: 0 }, runs: [run(2, 'failure'), run(1, 'running', jobs)] } } }), self, opts({ tab: 'ci' })));
    expect(rows[2]).toBe('1 in flight · 1 failed · 0 passed lately');
    expect(rows[4]).toMatch(/^◔ wf1 dev · started/);
    expect(rows).toContain('  ▸ build 2/3 compile');
    expect(rows.some((r) => r.startsWith('✗ wf2'))).toBe(true);
  });

  it('gives each decision its options and a dismissal as controls', () => {
    const f = fleet({ work: [work(1, 'blocked')], decisions: [decision('d1', true, 1, { options: ['pin', 'track'], body: 'why\nmore' })] });
    const rows = paneRows(f, self, opts({ tab: 'inbox' }));
    expect(text(rows)[2]).toBe('waiting  r#1 qd1 · 0s');
    expect(text(rows)[3]).toBe('         why');
    expect(rows[4]!.filter((s) => s.press).map((s) => s.press)).toEqual(['answer:d1:0', 'answer:d1:1', 'dismiss:d1']);
  });

  it('cuts to the room it has', () => {
    const f = fleet({ work: Array.from({ length: 30 }, (_, i) => work(i + 1, 'queued')) });
    const rows = text(paneRows(f, self, opts({ rows: 12 })));
    expect(rows.length).toBe(12);
    expect(rows[11]).toMatch(/^… \d+ more rows$/);
  });

  it('fills a bar to its width, giving every part at least a cell', () => {
    const cells = (parts: Row) => parts.map((s) => s.text).join('');
    expect(cells(bar([{ n: 1, color: 'a' }, { n: 99, color: 'b' }], 100, 10)).length).toBe(10);
    expect(bar([{ n: 1, color: 'a' }, { n: 99, color: 'b' }], 100, 10)[0]!.text).toBe('━');
    expect(cells(bar([{ n: 1, color: 'a' }], 4, 8))).toBe('━━──────');
  });

  it('shows the band and status only when there is something to show', () => {
    expect(bandRow(fleet({ work: [work(1, 'working')] }), self)).toBeUndefined();
    expect(text([bandRow(fleet({ work: [work(1, 'failing')] }), self)!])[0]).toBe('helm 1 active · 1 need attention');
    expect(statusText(fleet({}), self)).toBeUndefined();
    expect(statusText(fleet({ work: [work(1, 'ci'), work(2, 'working')] }), self)).toBe('helm 2▸ 1ci');
  });
});
