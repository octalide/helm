import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
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

  it('lists every tier and the issue in the prompt', () => {
    const p = routingPrompt({ repo: 'o/r', number: 3, title: 'bump', state: 'open', url: '', pr: false, author: 'a', labels: ['chore'], body: 'bump the version', comments: [] }, cfg.tiers);
    for (const t of cfg.tiers) expect(p).toContain(`${t.name} (${t.model}, ${t.effort} effort)`);
    expect(p).toContain('Issue o/r#3: bump');
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
