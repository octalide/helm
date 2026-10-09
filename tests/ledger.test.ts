import { describe, expect, it } from 'vitest';
import { hasWorker } from '../src/core/work.ts';
import { phaseOf, viewOf } from '../src/daemon/derive.ts';
import { isOpen } from '../src/core/decision.ts';
import type { Decision } from '../src/core/types.ts';
import { ClaimError, emptyLedger, Ledger, LEDGER_VERSION, type LedgerData } from '../src/daemon/ledger.ts';
import { check, forge, issue, pull, T0 } from './fixtures.ts';

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

  it('keeps a known session\'s role and repository unless a role is asked, and tells a new one its role', () => {
    const { l } = ledger();
    const kinds = (id: string) => Object.values(l.data.subscriptions).filter((s) => s.session === id).map((s) => s.scope.kind);
    expect(l.register({ id: 'A', cwd: '/', repo: 'o/r', protocol: 3 }).role).toBe('repo');
    expect(l.register({ id: 'O', cwd: '/', protocol: 3 }).role).toBe('other');
    l.setRole('A', 'coordinator');
    // neither a mod that asks nothing nor an older one sending its guess overwrites the stored role
    expect(l.register({ id: 'A', cwd: '/', repo: 'o/x', protocol: 3 })).toMatchObject({ role: 'coordinator', repo: 'o/r' });
    expect(l.register({ id: 'A', cwd: '/', repo: 'o/r', role: 'repo' }).role).toBe('coordinator');
    expect(kinds('A')).toEqual(['fleet']);
    // a new id after a /clear goes on in the role of the one it went on from
    expect(l.register({ id: 'A2', cwd: '/', repo: 'o/r', from: 'A', protocol: 3 }).role).toBe('coordinator');
    expect(l.register({ id: 'A2', cwd: '/', role: 'repo', protocol: 3 }).role).toBe('repo');
    expect(kinds('A2')).toEqual(['work']);
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

  it('addresses an agent question and a stall to the live owner, everything else to the person, and keeps records out of the open', () => {
    const { l } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const to = (d: Decision) => [d.kind, d.to, d.session];
    const stall = (issue: number) => ({ kind: 'stall' as const, repo: 'o/r', issue, title: 's', body: '', blocking: false });
    const asked = l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'blocked', question: { title: 'q', body: '' }, choices: [{ title: 'c', body: '' }] }).decisions;
    expect(asked.map(to)).toEqual([['question', 'session', 'A'], ['choice', 'person', undefined]]);
    expect(asked.map(isOpen)).toEqual([true, false]);
    expect(to(l.report({ session: 'A', repo: 'o/r', issue: 1, state: 'blocked', question: { title: 'mine', body: '' } }).decisions[0]!)).toEqual(['question', 'person', undefined]);
    const routing = l.decide({ kind: 'routing', repo: 'o/r', issue: 1, title: 'r', body: '', blocking: false, from: { session: 'A' } });
    expect([to(routing), isOpen(routing)]).toEqual([['routing', 'person', undefined], false]);
    expect(to(l.raise('stall:work:o/r#1', 'c', stall(1))!)).toEqual(['stall', 'session', 'A']);
    expect(to(l.raise('stall:work:o/r#9', 'c', stall(9))!)).toEqual(['stall', 'person', undefined]);
    expect(to(l.decide({ kind: 'failure', repo: 'o/r', title: 'f', body: '', blocking: false }))).toEqual(['failure', 'person', undefined]);
  });

  it('escalates a session\'s decision to the person once, and never a record', () => {
    const { l } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const [q, c] = l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'blocked', question: { title: 'q', body: '' }, choices: [{ title: 'c', body: '' }] }).decisions;
    expect(l.escalate(q!.id, 'session A', 'not mine to call')).toMatchObject({ to: 'person', state: 'open', escalated: { by: 'session A', note: 'not mine to call', at: T0 } });
    expect(q!.session).toBeUndefined();
    expect(() => l.escalate(q!.id, 'session A')).toThrow(/already the person's/);
    expect(() => l.escalate(c!.id, 'session A')).toThrow(/record/);
  });

  it('hands what a gone session held to the person, and addresses nothing new to it', () => {
    const { l, tick } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const q = l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'blocked', question: { title: 'q', body: '' } }).decisions[0]!;
    tick(200_000);
    l.sweep(120_000);
    expect(l.orphaned('A').map((d) => d.id)).toEqual([q.id]);
    expect([q.to, q.session, q.escalated?.by]).toEqual(['person', undefined, 'helm']);
    expect(l.raise('stall:work:o/r#1', 'c', { kind: 'stall', repo: 'o/r', issue: 1, title: 's', body: '', blocking: false })!.to).toBe('person');
  });

  it('hands a gone repo session\'s unfinished work, subscriptions and decisions to its repository\'s new one, in backlog order', () => {
    const { l, tick } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.queue({ session: 'A', repo: 'o/r', issues: [3, 1] }, () => undefined);
    l.claim({ session: 'A', repo: 'o/r', issue: 2, agent: 'x' }, 'two');
    l.claim({ session: 'A', repo: 'o/r', issue: 9 }, 'nine');
    l.finish('o/r', 9, 'merged');
    const pr = l.subscribe({ session: 'A', agent: 'x', repo: 'o/r', scope: { kind: 'pr', number: 7 } });
    const q = l.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 2, state: 'blocked', question: { title: 'q', body: '' } }).decisions[0]!;
    const own = l.decide({ kind: 'question', repo: 'o/r', issue: 2, title: 'mine', body: '', blocking: true, from: { session: 'A', agent: 'x' } });
    l.escalate(own.id, 'session A');
    tick(200_000);
    l.sweep(120_000);
    l.orphaned('A');
    l.register({ id: 'C', cwd: '/', role: 'coordinator', repo: 'o/r' });
    expect(l.adopt('C')).toBeUndefined();
    l.register({ id: 'B', cwd: '/', repo: 'o/r' });
    const a = l.adopt('B')!;
    expect(a.from).toEqual(['A']);
    expect(a.work.map((w) => [w.issue, w.owner, w.order, w.adopted?.from])).toEqual([
      [3, 'B', 1, 'A'],
      [1, 'B', 2, 'A'],
      [2, 'B', 3, 'A'],
    ]);
    expect(l.data.work['o/r#2']!.adopted?.agent).toBe('x');
    expect(l.data.work['o/r#9']!.owner).toBe('A');
    expect(a.subscriptions).toEqual([pr.id]);
    expect(l.data.subscriptions[pr.id]).toMatchObject({ session: 'B', agent: 'x' });
    // the question helm handed to the person once A was gone is B's now; the one A escalated itself stays the person's
    expect(a.decisions.map((d) => d.id)).toEqual([q.id]);
    expect([q.to, q.session, q.escalated, own.to]).toEqual(['session', 'B', undefined, 'person']);
    expect(l.held('B', 'x')?.why).toBe('inherited');
    // a new agent on the work takes up what the gone one waited on
    l.claim({ session: 'B', repo: 'o/r', issue: 2, agent: 'y' }, 'two');
    expect([l.data.subscriptions[pr.id]?.agent, l.held('B', 'y')]).toEqual(['y', undefined]);
    expect(l.adopt('B')).toBeUndefined();
  });

  it('takes nothing from a live session, and hands an ended one over exactly to the one it went on as', () => {
    const { l } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.queue({ session: 'A', repo: 'o/r', issues: [1] }, () => undefined);
    l.register({ id: 'B', cwd: '/', repo: 'o/r' });
    expect(l.adopt('B')).toBeUndefined();
    expect(l.data.work['o/r#1']!.owner).toBe('A');
    l.register({ id: 'A2', cwd: '/', repo: 'o/r' });
    expect(l.adopt('A2', 'A')!.work.map((w) => [w.issue, w.owner])).toEqual([[1, 'A2']]);
    expect(l.live('A')).toBe(false);
  });

  it('gives back what a session adopted and has not acted on once it is not that repository\'s repo session', () => {
    const { l, tick } = ledger();
    l.register({ id: 'A', cwd: '/', repo: 'o/r' });
    l.queue({ session: 'A', repo: 'o/r', issues: [1, 2] }, () => undefined);
    l.claim({ session: 'A', repo: 'o/r', issue: 3, agent: 'x' }, 'three');
    const pr = l.subscribe({ session: 'A', agent: 'x', repo: 'o/r', scope: { kind: 'pr', number: 7 } });
    const stall = l.decide({ kind: 'stall', repo: 'o/r', issue: 3, title: 's', body: '', blocking: false });
    tick(200_000);
    l.sweep(120_000);
    l.register({ id: 'B', cwd: '/', repo: 'o/r' });
    l.adopt('B');
    tick(1000);
    // B acts on #2: a dispatch makes it B's own
    l.claim({ session: 'B', repo: 'o/r', issue: 2, agent: 'y' }, 'two');
    expect(l.giveBack('B')).toBeUndefined();
    l.setRole('B', 'coordinator');
    const g = l.giveBack('B')!;
    expect([g.to, g.work.map((w) => [w.issue, w.owner, w.adopted]), g.subscriptions, g.decisions.map((d) => [d.id, d.session])]).toEqual([
      ['A'],
      [
        [1, 'A', undefined],
        [3, 'A', undefined],
      ],
      [pr.id],
      [[stall.id, 'A']],
    ]);
    expect([l.data.work['o/r#2']!.owner, l.data.subscriptions[pr.id]!.session, l.data.sessions.B!.adoptions]).toEqual(['B', 'A', undefined]);
    expect(l.giveBack('B')).toBeUndefined();
  });

  it('reads a version 1 ledger, leaving its decisions with the person', () => {
    const old = { ...emptyLedger(), version: 1, decisions: { d1: { id: 'd1', kind: 'question', title: 'q', body: '', blocking: true, state: 'open', createdAt: T0, updatedAt: T0 } } } as unknown as LedgerData;
    const l = new Ledger(old, () => T0);
    expect([l.data.version, l.data.decisions.d1!.to]).toEqual([LEDGER_VERSION, 'person']);
  });

  it('reads a version 2 ledger, making a coordinator its default role overwrote one again and recording what it adopted', () => {
    const { l: v2, tick } = ledger();
    v2.register({ id: 'C', cwd: '/', role: 'coordinator' });
    v2.register({ id: 'A', cwd: '/', repo: 'o/r' });
    v2.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    v2.subscribe({ session: 'A', repo: 'o/r', scope: { kind: 'pr', number: 7 } });
    // the version 2 register: a role it was sent overwrote the stored one, and kept the old role's subscription
    v2.data.sessions.C!.role = 'repo';
    v2.data.sessions.C!.repo = 'o/r';
    v2.subscribe({ session: 'C', scope: { kind: 'work' } });
    v2.decide({ kind: 'stall', repo: 'o/r', issue: 1, title: 's', body: '', blocking: false });
    tick(200_000);
    v2.sweep(120_000);
    v2.heartbeat('C', []);
    const a = v2.adopt('C')!;
    v2.record([{ id: 'e', kind: 'work', at: T0, tags: ['adopted'], text: '', owner: 'C', detail: [`decisions now addressed to this session: ${a.decisions[0]!.id} (stall #1)`, `subscriptions now this session's: ${a.subscriptions.join(' ')}`] }]);
    const data = JSON.parse(JSON.stringify(v2.data)) as LedgerData;
    for (const s of Object.values(data.sessions)) delete s.adoptions;
    data.version = 2;
    const l = new Ledger(data, () => T0 + 300_000);
    const c = l.data.sessions.C!;
    expect([c.role, Object.values(l.data.subscriptions).filter((s) => s.session === 'C' && !s.agent).map((s) => s.scope.kind)]).toEqual(['coordinator', ['fleet', 'pr']]);
    expect(c.adoptions?.map((r) => [r.work.map((w) => w.key), r.subscriptions.map((s) => s.was), r.decisions.map((d) => d.was.session)])).toEqual([[['o/r#1'], ['A'], ['A']]]);
    l.register({ id: 'C', cwd: '/', repo: 'o/r', role: 'repo' });
    expect(l.giveBack('C')!.work.map((w) => [w.issue, w.owner])).toEqual([[1, 'A']]);
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
    // its pr head settled ci that its subscription held back: the delivery can no longer come
    const green = pull(101, { checks: [check('t', 'success')] });
    expect(phaseOf({ ...a, report: { state: 'waiting', at: T0 } }, { agent: 'idle', pull: green, blocking: false, issueClosed: false, stuck: true })).toBe('stalled');
    expect(phaseOf({ ...a, report: { state: 'waiting', at: T0 } }, { agent: 'running', pull: green, blocking: false, issueClosed: false, stuck: true })).toBe('ready');
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

  it('parks work set aside by a label or an open blocker while nobody is on it, and stopped work', () => {
    const p = pull(101, { draft: true });
    const labelled = forge({ issues: [issue(1, { labels: ['Blocked'] })], pulls: [p] });
    const waiting = forge({ issues: [issue(1, { blockedBy: 1 })], pulls: [p] });
    const a = { ...w, agent: 'x', owner: 'A' };
    expect(viewOf(a, labelled, undefined, new Map(), [], T0).phase).toBe('parked');
    expect(viewOf(a, waiting, undefined, new Map(), [], T0).phase).toBe('parked');
    expect(viewOf(w, forge({ issues: [issue(1, { labels: ['parked'] })] }), undefined, new Map(), [], T0).phase).toBe('parked');
    expect(phaseOf(a, { agent: 'running', pull: p, blocking: false, issueClosed: false, setAside: true })).toBe('draft');
    expect(phaseOf(a, { agent: 'gone', pull: p, blocking: true, issueClosed: false, setAside: true })).toBe('blocked');
    // a stopped report sets it aside whatever its agent is doing
    expect(['running', 'completed', 'gone'].map((agent) => phaseOf({ ...a, report: { state: 'stopped', at: T0 } }, { agent: agent as 'running', pull: p, blocking: false, issueClosed: false }))).toEqual(['parked', 'parked', 'parked']);
  });

  it('finds the pr by closing reference or branch and the worktree by branch', () => {
    const f = forge({ pulls: [pull(101, { closes: [], head: 'fix/1' })] });
    const local = { repo: 'o/r', checkouts: ['/r'], worktrees: [{ path: '/r/wt', branch: 'fix/1', sha: '', main: false, dirty: 2 }], branches: [], scannedAt: T0 };
    const v = viewOf(w, f, local, new Map(), [], T0);
    expect(v.pull?.number).toBe(101);
    expect(v.worktree?.path).toBe('/r/wt');
  });
});
