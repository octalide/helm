import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig, sourcesOf } from '../src/core/config.ts';
import type { WorkView } from '../src/core/types.ts';
import { parseScope } from '../src/core/scope.ts';
import { parseRouting, routingPrompt } from '../src/mod/routing.ts';

const cfg = DEFAULT_CONFIG.routing;

describe('routing', () => {
  it('reads the judge answer, clamped', () => {
    const r = parseRouting('sure: {"tier": "deep", "confidence": 1.4, "reason": "touches codegen"}', cfg, 0);
    expect([r.tier, r.model, r.effort, r.confidence, r.reason]).toEqual(['deep', 'claude-opus-5-5', 'high', 1, 'touches codegen']);
  });

  it('falls back on an unknown tier at no confidence', () => {
    const r = parseRouting('{"tier": "huge"}', cfg, 0);
    expect([r.tier, r.confidence]).toEqual(['standard', 0]);
  });

  it('refuses a caller-only tier from the judge and falls back', () => {
    const r = parseRouting('{"tier": "frontier", "confidence": 0.9}', cfg, 0);
    expect([r.tier, r.model, r.confidence]).toEqual(['standard', 'claude-opus-5-5', 0]);
    expect(r.reason).toMatch(/frontier, which is caller-only/);
  });

  it('lists every tier the judge may pick and the issue in the prompt', () => {
    const p = routingPrompt({ repo: 'o/r', number: 3, title: 'bump', state: 'open', url: '', pr: false, author: 'a', labels: ['chore'], body: 'bump the version', comments: [] }, cfg.tiers);
    for (const t of cfg.tiers) expect(p.includes(`${t.name} (${t.model}, ${t.effort} effort)`)).toBe(t.judge !== false);
    expect(p).not.toContain('frontier');
    expect(p).toContain('Issue o/r#3: bump');
    expect(p).not.toContain('already done');
  });

  it('shows the judge the work a resume has left', () => {
    const issue = { repo: 'o/r', number: 3, title: 'bump', state: 'open', url: '', pr: false, author: 'a', labels: [], body: 'b', comments: [] };
    const work = {
      repo: 'o/r', issue: 3, title: 'bump', order: 0, queuedAt: 0, updatedAt: 0, phase: 'draft', verdict: 'success', jobs: [], decisions: 0,
      pull: { number: 9, url: '', draft: true, state: 'open', head: 'feat/3', sha: 'x' },
      checks: [{ name: 'test', state: 'success' }],
      report: { state: 'waiting', note: 'ci green', at: 0 },
      plan: [{ text: 'edit', done: true }, { text: 'mark ready', done: false }],
    } as unknown as WorkView;
    const p = routingPrompt(issue, cfg.tiers, work);
    expect(p).toContain('pull request #9: draft, ci success 1/1');
    expect(p).toContain('last report: waiting: ci green');
    expect(p).toContain('plan, 1 of 2 steps done');
    expect(p).toContain('- [ ] mark ready');
    expect(p).toContain('Route on the work that is left');
  });
});

describe('config', () => {
  const tier = (name: string, more = {}) => ({ name, model: 'm', effort: 'high', when: 'w', ...more });

  it('refuses a caller-only fallback, a twice-named tier and an out-of-range field', () => {
    expect(() => mergeConfig(DEFAULT_CONFIG, { routing: { fallback: 'frontier' } })).toThrow(/caller-only/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { routing: { tiers: [tier('a'), tier('a')], fallback: 'a' } })).toThrow(/named twice/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { routing: { tiers: [tier('a', { judge: 'no' })], fallback: 'a' } })).toThrow(/judge must be true or false/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { web: { port: 70000 } })).toThrow(/web.port/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { poll: { idle: 0 } })).toThrow(/poll.idle/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { routing: { review: 2 } })).toThrow(/routing.review/);
  });

  it('names each field\'s source', () => {
    const s = sourcesOf({ roots: [], poll: { idle: 5 }, routing: { tiers: [] } });
    expect([s.roots, s.repos, s['poll.idle'], s['poll.active'], s['routing.tiers'], s['routing.judge']]).toEqual(['user', 'default', 'user', 'default', 'user', 'default']);
  });
});

describe('scope', () => {
  it('parses each spelling', () => {
    expect(parseScope('pr #14')).toEqual({ kind: 'pr', number: 14 });
    expect(parseScope('tag v1.*')).toEqual({ kind: 'tag', glob: 'v1.*' });
    expect(parseScope(undefined)).toEqual({ kind: 'repo' });
    expect(() => parseScope('pr x')).toThrow(/takes a number/);
  });
});
