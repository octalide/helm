import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { HelmClient } from '../src/mod/client.ts';
import { dispatchIssues, type DispatchPort } from '../src/mod/dispatch.ts';
import type { ToolEnv } from '../src/mod/tools.ts';

function env(issues: Record<number, { state: string; pr?: boolean }>) {
  const calls: { path: string; body: unknown }[] = [];
  const http = async (url: string, init: { method?: string; body?: string }) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const json = (v: unknown, status = 200) => ({ status, ok: status < 300, text: JSON.stringify(v) });
    if (path === '/v1/config') return json({ routing: DEFAULT_CONFIG.routing });
    const m = /issues\/(\d+)$/.exec(path);
    if (m) {
      const i = issues[Number(m[1])]!;
      return json({ repo: 'o/r', number: Number(m[1]), title: `t${m[1]}`, state: i.state, url: 'u', pr: i.pr ?? false, author: 'a', labels: [], body: 'b', comments: [] });
    }
    if (path === '/v1/fleet') return json({ work: [] });
    if (path === '/v1/work/claim') return json({});
    if (path === '/v1/decisions') return json({ id: 'd1' });
    return json({ error: 'nope' }, 404);
  };
  const e: ToolEnv = { client: new HelmClient(http, '/s'), session: () => 'S', now: () => 0, repo: () => 'o/r', pending: () => [], version: '0' };
  return { e, calls };
}

describe('dispatch', () => {
  it('routes by the judge, spawns at the tier effort and logs the pick', async () => {
    const { e, calls } = env({ 5: { state: 'open' } });
    const spawned: unknown[] = [];
    const port: DispatchPort = {
      now: () => 0,
      agentType: async (model, effort) => `helm:issue-${model}-${effort}`,
      complete: async () => ({ text: '{"tier": "mechanical", "confidence": 0.4, "reason": "a version bump"}' }),
      spawn: async (a) => (spawned.push(a), { agentId: 'A1' }),
    };
    const out = await dispatchIssues(e, port, { issues: [5] });
    expect(out).toBe('o/r#5 → mechanical claude-haiku-5-5/high, agent A1: a version bump');
    expect(spawned).toEqual([{ subagentType: 'helm:issue-claude-haiku-5-5-high', description: '#5 t5', prompt: 'Issue o/r#5: t5\nu' }]);
    const claims = calls.filter((c) => c.path === '/v1/work/claim').map((c) => c.body as { agent?: string });
    expect(claims.map((c) => c.agent)).toEqual([undefined, 'A1']);
    const decision = calls.find((c) => c.path === '/v1/decisions')?.body as { title: string; blocking: boolean };
    expect(decision.title).toBe('#5 routed to mechanical (claude-haiku-5-5/high), low confidence');
    expect(decision.blocking).toBe(false);
  });

  it('skips closed issues and pull requests, and keeps going past a failure', async () => {
    const { e } = env({ 1: { state: 'closed' }, 2: { state: 'open', pr: true }, 3: { state: 'open' } });
    const port: DispatchPort = { now: () => 0, agentType: async () => 't', complete: async () => ({ failed: 'api-error' }), spawn: async () => ({ deny: 'no room' }) };
    const out = (await dispatchIssues(e, port, { issues: [1, 2, 3] })).split('\n');
    expect(out).toEqual(['o/r#1: closed, not dispatched', 'o/r#2: a pull request, not dispatched', 'o/r#3: the agent did not start: no room; it stays queued']);
  });
});
