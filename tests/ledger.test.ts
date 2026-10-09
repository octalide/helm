import { describe, expect, it } from 'vitest';
import { hasWorker } from '../src/core/work.ts';
import { phaseOf, viewOf } from '../src/daemon/derive.ts';
import { ClaimError, emptyLedger, Ledger } from '../src/daemon/ledger.ts';
import { check, forge, pull, T0 } from './fixtures.ts';

const ledger = () => {
  let now = T0;
  const l = new Ledger(emptyLedger(), () => now);
  return { l, tick: (ms: number) => (now += ms) };
};

describe('ledger', () => {
  it('gives each repo session a work subscription and a coordinator the fleet', () => {
    const { l } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.register({ id: 'C', cwd: '/', role: 'coordinator' });
    expect(Object.values(l.data.subscriptions).map((s) => [s.session, s.scope.kind])).toEqual([
      ['A', 'work'],
      ['C', 'fleet'],
    ]);
  });

  it('refuses a claim on work a live session owns, unless forced', () => {
    const { l } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.register({ id: 'B', cwd: '/', repo: 'o/r' });
    l.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    expect(() => l.claim({ session: 'B', repo: 'o/r', issue: 1 }, undefined)).toThrow(ClaimError);
    expect(l.claim({ session: 'B', repo: 'o/r', issue: 1, force: true }, undefined).owner).toBe('B');
  });

  it('keeps the reported plan and each phase change once', () => {
    const { l, tick } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'working', plan: [{ text: 'a', done: true }, { text: 'b', done: false }] });
    expect(l.data.work['o/r#1']!.plan).toEqual([{ text: 'a', done: true }, { text: 'b', done: false }]);
    l.phase('o/r', 1, 'working');
    tick(1000);
    l.phase('o/r', 1, 'working');
    l.phase('o/r', 1, 'ci');
    expect(l.data.work['o/r#1']!.history).toEqual([{ phase: 'working', at: T0 }, { phase: 'ci', at: T0 + 1000 }]);
  });

  it('finishes work at the time it closed, once', () => {
    const { l } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.claim({ session: 'A', repo: 'o/r', issue: 1 }, 'one');
    expect(l.finish('o/r', 1, 'merged', T0 - 5000)?.finished).toEqual({ at: T0 - 5000, how: 'merged' });
    expect(l.finish('o/r', 1, 'closed')).toBeUndefined();
  });

  it('hands a letter out once', () => {
    const { l } = ledger();
    const letter = l.post({ session: 'A', text: 'hi', events: [], subs: [] });
    expect(l.take(letter.id)?.text).toBe('hi');
    expect(l.take(letter.id)).toBeUndefined();
  });

  it('opens a blocking question on a blocked report and resolves it once the agent moves on', () => {
    const { l } = ledger();
    l.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const { decisions } = l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'blocked', question: { title: 'which?', body: 'a or b', options: ['a', 'b'] } });
    expect(decisions[0]?.blocking).toBe(true);
    l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'working' });
    expect(l.data.decisions[decisions[0]!.id]?.state).toBe('resolved');
  });

  it('holds a dismissed condition until it changes or ends, then raises it again', () => {
    const { l } = ledger();
    const b = { kind: 'stall' as const, repo: 'o/r', issue: 1, title: 'stalled', body: '', blocking: false };
    const first = l.raise('stall:work:o/r#1', 'agent x · pr @a', b)!;
    expect(l.raise('stall:work:o/r#1', 'agent x · pr @b', b)).toBeUndefined();
    expect(first.condition).toBe('agent x · pr @b');
    l.dismiss(first.id);
    expect(l.raise('stall:work:o/r#1', 'agent x · pr @b', b)).toBeUndefined();
    const moved = l.raise('stall:work:o/r#1', 'agent y · pr @b', b)!;
    expect(moved.id).not.toBe(first.id);
    l.dismiss(moved.id);
    l.resolveKey('stall:work:o/r#1');
    expect(l.raise('stall:work:o/r#1', 'agent y · pr @b', b)?.state).toBe('open');
  });

  it('marks a quiet session gone', () => {
    const { l, tick } = ledger();
    l.register({ id: 'A', cwd: '/' });
    tick(200_000);
    expect(l.sweep(120_000).map((s) => s.id)).toEqual(['A']);
    expect(l.live('A')).toBe(false);
  });
});

describe('phase', () => {
  const w = { repo: 'o/r', issue: 1, title: 't', order: 1, queuedAt: T0, updatedAt: T0 };
  it('walks queued, working, draft, ci, failing, ready, done', () => {
    expect(phaseOf(w, { blocking: false, issueClosed: false })).toBe('queued');
    const a = { ...w, agent: 'x' };
    expect(phaseOf(a, { agent: 'running', blocking: false, issueClosed: false })).toBe('working');
    expect(phaseOf(a, { agent: 'running', pull: pull(101, { draft: true }), blocking: false, issueClosed: false })).toBe('draft');
    expect(phaseOf(a, { agent: 'running', pull: pull(101, { checks: [check('t', 'running')] }), blocking: false, issueClosed: false })).toBe('ci');
    expect(phaseOf(a, { agent: 'running', pull: pull(101, { checks: [check('t', 'failure')] }), blocking: false, issueClosed: false })).toBe('failing');
    expect(phaseOf(a, { agent: 'completed', pull: pull(101, { checks: [check('t', 'success')] }), blocking: false, issueClosed: false })).toBe('ready');
    expect(phaseOf(a, { pull: pull(101, { state: 'merged' }), blocking: false, issueClosed: false })).toBe('done');
  });

  it('counts an agent waiting on a delivery as on the work, and a vanished one as stalled', () => {
    const a = { ...w, agent: 'x' };
    expect(phaseOf({ ...a, report: { state: 'waiting', at: T0 } }, { agent: 'completed', pull: pull(101, { draft: true }), blocking: false, issueClosed: false })).toBe('draft');
    expect(phaseOf(a, { agent: 'gone', blocking: false, issueClosed: false })).toBe('stalled');
  });

  it('counts a live session working an issue itself as its worker', () => {
    const self = { ...w, owner: 'A', report: { state: 'working' as const, at: T0 } };
    expect(phaseOf(self, { ownerLive: true, blocking: false, issueClosed: false })).toBe('working');
    expect(phaseOf(self, { ownerLive: true, pull: pull(101, { draft: true }), blocking: false, issueClosed: false })).toBe('draft');
    expect(phaseOf(self, { ownerLive: false, pull: pull(101, { draft: true }), blocking: false, issueClosed: false })).toBe('stalled');
    expect(phaseOf({ ...w, owner: 'A' }, { ownerLive: true, blocking: false, issueClosed: false })).toBe('queued');
    // a repository with such work polls as active
    expect([hasWorker(self), hasWorker({ ...w, agent: 'x' }), hasWorker({ ...w, owner: 'A' })]).toEqual([true, true, false]);
  });

  it('finds the pr by closing reference or branch and the worktree by branch', () => {
    const f = forge({ pulls: [pull(101, { closes: [], head: 'fix/1' })] });
    const local = { repo: 'o/r', checkouts: ['/r'], worktrees: [{ path: '/r/wt', branch: 'fix/1', sha: '', main: false, dirty: 2 }], branches: [], scannedAt: T0 };
    const v = viewOf(w, f, local, new Map(), [], T0);
    expect(v.pull?.number).toBe(101);
    expect(v.worktree?.path).toBe('/r/wt');
  });
});
