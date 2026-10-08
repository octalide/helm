import { describe, expect, it } from 'vitest';
import { buildTree, findNode, percent } from '../src/core/tree.ts';
import { epicEvents } from '../src/daemon/epics.ts';
import type { Child, WorkView } from '../src/core/types.ts';
import { treeBlock } from '../src/mod/format.ts';
import { forge, issue, T0 } from './fixtures.ts';

const child = (repo: string, number: number, over: Partial<Child> = {}): Child => ({ repo, number, title: `c${number}`, url: `https://github.com/${repo}/issues/${number}`, state: 'open', ...over });
const work = (repo: string, issue: number, phase: WorkView['phase'], over: Partial<WorkView> = {}): WorkView => ({ repo, issue, title: `w${issue}`, owner: 'S', order: issue, queuedAt: T0, updatedAt: T0, phase, verdict: 'none', checks: [], jobs: [], decisions: 0, ...over });

describe('tree', () => {
  it('rolls an epic up over its leaves, joined to the work on them', () => {
    const f = forge({
      issues: [issue(1, { subIssues: { total: 4, done: 1 } }), issue(2, { parent: { repo: 'o/r', number: 1 } }), issue(3, { parent: { repo: 'o/r', number: 1 } }), issue(4, { parent: { repo: 'o/r', number: 1 } })],
      children: { 1: [child('o/r', 2), child('o/r', 3), child('o/r', 4), child('o/r', 5, { state: 'closed' })] },
    });
    const [root, ...rest] = buildTree([f], [work('o/r', 2, 'ci', { plan: [{ text: 'a', done: true }, { text: 'b', done: false }] }), work('o/r', 3, 'blocked')]);
    expect(rest).toEqual([]);
    expect(root!.rollup).toEqual({ total: 4, done: 1, active: 1, attention: 1, ci: 1, ready: 0, queued: 0, unowned: 1 });
    expect(percent(root!.rollup)).toBe(25);
    expect(root!.children.map((c) => c.phase)).toEqual(['ci', 'blocked', undefined, 'done']);
    expect(root!.children[0]!.plan).toEqual({ done: 1, total: 2 });
  });

  it('nests sub-epics across watched repositories and counts an unwatched one from its summary', () => {
    const a = forge({ repo: 'o/a', issues: [issue(1, { subIssues: { total: 2, done: 0 } })], children: { 1: [child('o/b', 7, { subIssues: { total: 1, done: 0 } }), child('x/y', 9, { subIssues: { total: 3, done: 2 } })] } });
    const b = forge({ repo: 'o/b', issues: [issue(7, { parent: { repo: 'o/a', number: 1 }, subIssues: { total: 1, done: 0 } })], children: { 7: [child('o/b', 8)] } });
    const tree = buildTree([a, b], [work('o/b', 8, 'working')]);
    expect(tree.map((t) => `${t.repo}#${t.number}`)).toEqual(['o/a#1']);
    expect(tree[0]!.rollup).toMatchObject({ total: 4, done: 2, active: 1 });
    expect(tree[0]!.children[1]!.external).toBe(true);
    const hit = findNode(tree, 'o/b', 8);
    expect(hit?.path.map((p) => p.number)).toEqual([1, 7]);
    expect(treeBlock(tree).split('\n')).toEqual([
      'o/a#1 [epic] issue 1 · 2/4 done (50%) · 1 active',
      '  o/b#7 [epic] issue 7 · 0/1 done (0%) · 1 active',
      '    #8 [working] c8',
      '  x/y#9 [epic] c9 · 2/3 done (67%) (not watched)',
    ]);
  });

  it('stops at a cycle instead of recursing', () => {
    const f = forge({ issues: [issue(1, { subIssues: { total: 1, done: 0 } }), issue(2, { subIssues: { total: 1, done: 0 } })], children: { 1: [child('o/r', 2)], 2: [child('o/r', 1)] } });
    expect(buildTree([f], [])).toEqual([]);
    const g = forge({ issues: [issue(1, { subIssues: { total: 1, done: 0 } })], children: { 1: [child('o/r', 1)] } });
    expect(buildTree([g], [])[0]!.rollup.total).toBe(1);
  });

  it('announces an epic once its rollup moves, with the phase changes under it', () => {
    const f = forge({ issues: [issue(1, { subIssues: { total: 2, done: 0 } })], children: { 1: [child('o/r', 2), child('o/r', 3)] } });
    const first = epicEvents(buildTree([f], [work('o/r', 2, 'working')]), undefined, [], T0);
    expect(first.events).toEqual([]);
    const same = epicEvents(buildTree([f], [work('o/r', 2, 'working')]), first.seen, [], T0);
    expect(same.events).toEqual([]);
    const change = { id: 'w', kind: 'work' as const, repo: 'o/r', issue: 2, at: T0, tags: ['phase', 'ready'], text: 'o/r#2 working → ready: w2' };
    const moved = epicEvents(buildTree([f], [work('o/r', 2, 'ready'), work('o/r', 3, 'queued')]), first.seen, [change], T0);
    expect(moved.events.map((e) => [e.text, e.detail])).toEqual([['o/r#1 0%: issue 1', ['0/2 done (0%) · 1 active · 1 ready · 1 queued', 'o/r#2 working → ready: w2']]]);
    // a move that leaves every count where it was is still heard
    const draft = { ...change, tags: ['phase', 'draft'], text: 'o/r#2 working → draft: w2' };
    const quiet = epicEvents(buildTree([f], [work('o/r', 2, 'draft')]), same.seen, [draft], T0);
    expect(quiet.events.map((e) => e.detail?.at(-1))).toEqual(['o/r#2 working → draft: w2']);
  });
});
