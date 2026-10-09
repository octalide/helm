import { describe, expect, it } from 'vitest';
import { route } from '../src/daemon/deliver.ts';
import { ended, heldKey, globMatch, matches, retiredBy } from '../src/daemon/watch.ts';
import { forge, issue, pull } from './fixtures.ts';
import type { HelmEvent, Subscription } from '../src/core/types.ts';

const ctx = { protectedBranches: new Set(['dev', 'main']) };
const sub = (over: Partial<Subscription>): Subscription => ({ id: 's1', repo: 'o/r', scope: { kind: 'repo' }, ci: 'failures', bots: false, session: 'S', createdAt: 0, ...over });
const ev = (over: Partial<HelmEvent>): HelmEvent => ({ id: 'e', kind: 'issue', repo: 'o/r', at: 0, tags: [], text: 't', ...over });

describe('matches', () => {
  it('gives the fleet an epic\'s progress in place of its work, except what needs someone', () => {
    const s = sub({ scope: { kind: 'fleet' } });
    expect(matches(ev({ kind: 'work', issue: 2, epic: 'o/r#1', tags: ['phase', 'ci'] }), s, ctx)).toBe(false);
    expect(matches(ev({ kind: 'work', issue: 2, epic: 'o/r#1', tags: ['phase', 'blocked'] }), s, ctx)).toBe(true);
    expect(matches(ev({ kind: 'work', issue: 3, tags: ['phase', 'ci'] }), s, ctx)).toBe(true);
    expect(matches(ev({ kind: 'epic', issue: 1, tags: ['progress'] }), s, ctx)).toBe(true);
    expect(matches(ev({ kind: 'epic', issue: 1, tags: ['progress'] }), sub({ scope: { kind: 'work' } }), ctx)).toBe(false);
    expect(matches(ev({ kind: 'epic', issue: 1, tags: ['progress'] }), sub({}), ctx)).toBe(false);
  });

  it('takes a failed verdict but not a green one under failures', () => {
    const s = sub({});
    expect(matches(ev({ kind: 'ci', pr: 1, tags: ['settled', 'failure'] }), s, ctx)).toBe(true);
    expect(matches(ev({ kind: 'ci', pr: 1, tags: ['settled', 'success'] }), s, ctx)).toBe(false);
  });

  it('takes the green verdict that settles an until-settled pr subscription', () => {
    const s = sub({ scope: { kind: 'pr', number: 1 }, ci: 'failures', until: 'settled' });
    const e = ev({ kind: 'ci', pr: 1, tags: ['settled', 'success'] });
    expect(matches(e, s, ctx)).toBe(true);
    expect(retiredBy(e, s)).toBe(true);
  });

  it('holds back ci on a head the daemon found a subscription does not wait on', () => {
    const s = sub({ scope: { kind: 'pr', number: 1 }, ci: 'settled', until: 'settled', head: 'c'.repeat(40) });
    const on = (sha: string) => ev({ kind: 'ci', pr: 1, sha, tags: ['settled', 'success'] });
    const held = { ...ctx, held: new Set([heldKey('s1', 'a'.repeat(40))]) };
    expect(matches(on('a'.repeat(40)), s, held)).toBe(false);
    expect(matches(on('c'.repeat(40)), s, held)).toBe(true);
    expect(matches(on('a'.repeat(40)), sub({ id: 's2', scope: { kind: 'pr', number: 1 }, ci: 'settled' }), held)).toBe(true);
  });

  it('hears failed runs on a whole repository only on long-lived branches', () => {
    const s = sub({});
    expect(matches(ev({ kind: 'ci', run: 1, branch: 'dev', tags: ['completed', 'failure'] }), s, ctx)).toBe(true);
    expect(matches(ev({ kind: 'ci', run: 1, branch: 'feat/9', tags: ['completed', 'failure'] }), s, ctx)).toBe(false);
  });

  it('drops bots and housekeeping by default', () => {
    const s = sub({});
    expect(matches(ev({ tags: ['comment'], author: { login: 'dependabot', bot: true } }), s, ctx)).toBe(false);
    expect(matches(ev({ tags: ['labeled'] }), s, ctx)).toBe(false);
    expect(matches(ev({ tags: ['comment'] }), s, ctx)).toBe(true);
  });

  it('scopes work events to the owning session', () => {
    const s = sub({ scope: { kind: 'work' }, repo: undefined });
    expect(matches(ev({ kind: 'work', tags: ['phase', 'ci'], owner: 'S' }), s, ctx)).toBe(true);
    expect(matches(ev({ kind: 'work', tags: ['phase', 'ci'], owner: 'X' }), s, ctx)).toBe(false);
  });

  it('globs tags', () => {
    expect(globMatch('v1.*', 'v1.2.0')).toBe(true);
    expect(globMatch('v1.?', 'v1.22')).toBe(false);
  });
});

describe('route', () => {
  it('sends one letter per recipient and retires what ran its course', () => {
    const subs = [sub({ id: 's1' }), sub({ id: 's2', agent: 'A', scope: { kind: 'pr', number: 1 }, ci: 'settled', until: 'settled' }), sub({ id: 's3', agent: 'A', scope: { kind: 'pr', number: 1 } })];
    const e = ev({ kind: 'ci', pr: 1, tags: ['settled', 'failure'], text: 'ci settled failure: pr #1' });
    const { letters, retired } = route([e], subs, ctx, 0);
    expect(letters.map((l) => [l.session, l.agent, l.subs])).toEqual([
      ['S', undefined, ['s1']],
      ['S', 'A', ['s2', 's3']],
    ]);
    expect(letters[1]?.text.split('\n')[0]).toBe('[helm o/r]');
    expect(retired).toEqual(['s2']);
  });
});

describe('ended', () => {
  it('retires a subscription with an end once the forge shows its pr or issue ended', () => {
    const f = forge({ pulls: [pull(1, { state: 'merged' }), pull(2)], issues: [issue(5, { state: 'closed' })] });
    expect(ended(sub({ scope: { kind: 'pr', number: 1 }, until: 'settled' }), f)).toBe(true);
    expect(ended(sub({ scope: { kind: 'pr', number: 2 }, until: 'settled' }), f)).toBe(false);
    expect(ended(sub({ scope: { kind: 'pr', number: 1 } }), f)).toBe(false);
    expect(ended(sub({ scope: { kind: 'issue', number: 5 }, until: 'closed' }), f)).toBe(true);
    expect(ended(sub({ scope: { kind: 'issue', number: 5 }, until: 'merged' }), f)).toBe(false);
  });
});
