import { describe, expect, it } from 'vitest';
import { diffForge, emptyMemory } from '../src/daemon/events.ts';
import { check, forge, issue, iso, pull, run, T0 } from './fixtures.ts';

const opts = { now: T0 + 60_000, stallMs: 3600_000 };

describe('diffForge', () => {
  it('seeds silently on the first poll, remembering settled heads', () => {
    const next = forge({ issues: [issue(1, { createdAt: iso(T0) })], pulls: [pull(101, { checks: [check('test', 'success')] })] });
    const { events, memory } = diffForge(undefined, next, emptyMemory(), opts);
    expect(events).toEqual([]);
    expect(memory.settled[`101@${'a'.repeat(40)}`]).toBe('success');
  });

  it('reports a new issue but not one paged in from beyond the window', () => {
    const prev = forge();
    const next = forge({ issues: [issue(1, { createdAt: iso(T0 + 30_000) }), issue(2)], polledAt: T0 + 60_000 });
    const { events } = diffForge(prev, next, emptyMemory(), opts);
    expect(events.map((e) => e.text)).toEqual(['issue #1 opened by alice: issue 1']);
  });

  it('reports a comment with its author and text', () => {
    const prev = forge({ issues: [issue(1)] });
    const next = forge({ issues: [issue(1, { comments: 1, lastComment: { author: { login: 'bob', bot: false }, at: iso(T0), url: 'u', text: 'looks wrong' } })] });
    const [e] = diffForge(prev, next, emptyMemory(), opts).events;
    expect(e?.tags).toEqual(['comment']);
    expect(e?.author?.login).toBe('bob');
    expect(e?.detail).toEqual(['> looks wrong']);
  });

  it('settles a pr head once, and again when a rerun flips it', () => {
    const pending = forge({ pulls: [pull(101, { checks: [check('test', 'running'), check('lint', 'success')] })] });
    const failed = forge({ pulls: [pull(101, { checks: [check('test', 'failure'), check('lint', 'success')] })] });
    const passed = forge({ pulls: [pull(101, { checks: [check('test', 'success'), check('lint', 'success')] })] });
    const a = diffForge(pending, failed, emptyMemory(), opts);
    expect(a.events.map((e) => e.tags)).toEqual([['settled', 'failure']]);
    expect(a.events[0]?.detail).toEqual(['run 100 failed: test · log: helm log run=100']);
    const b = diffForge(failed, failed, a.memory, opts);
    expect(b.events).toEqual([]);
    const c = diffForge(failed, passed, b.memory, opts);
    expect(c.events.map((e) => e.tags)).toEqual([['settled', 'success']]);
  });

  it('raises a stalled head once', () => {
    const p = forge({ pulls: [pull(101, { checks: [check('test', 'running')] })] });
    const first = diffForge(p, p, emptyMemory(), opts);
    const late = { ...opts, now: opts.now + 2 * 3600_000 };
    const second = diffForge(p, p, first.memory, late);
    expect(second.events.map((e) => e.tags)).toEqual([['stalled']]);
    expect(diffForge(p, p, second.memory, late).events).toEqual([]);
  });

  it('reports a merge, a ready pr and a completed run', () => {
    const prev = forge({ pulls: [pull(101, { draft: true }), pull(102)], runs: [run(7)] });
    const next = forge({ pulls: [pull(101), pull(102, { state: 'merged', closedAt: iso(T0) })], runs: [run(7, { state: 'failure' })] });
    const tags = diffForge(prev, next, emptyMemory(), opts).events.map((e) => e.tags[0]);
    expect(tags.sort()).toEqual(['completed', 'merged', 'ready']);
  });
});
