import type { Check, ForgeState, Issue, Pull, Run } from '../src/core/types.ts';

export const T0 = Date.parse('2026-10-01T12:00:00Z');
export const iso = (ms: number) => new Date(ms).toISOString();

export function issue(n: number, over: Partial<Issue> = {}): Issue {
  return { number: n, title: `issue ${n}`, url: `https://github.com/o/r/issues/${n}`, state: 'open', author: { login: 'alice', bot: false }, labels: [], assignees: [], comments: 0, createdAt: iso(T0 - 86_400_000), updatedAt: iso(T0 - 86_400_000), ...over };
}

export function check(name: string, state: Check['state'], run = 100): Check {
  return { name, state, run, job: run * 10 + name.length, workflow: 'CI' };
}

export function pull(n: number, over: Partial<Pull> = {}): Pull {
  return {
    number: n,
    title: `pr ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    state: 'open',
    draft: false,
    author: { login: 'alice', bot: false },
    head: `feat/${n - 100}`,
    sha: 'a'.repeat(40),
    base: 'dev',
    closes: [n - 100],
    comments: 0,
    reviews: 0,
    checks: [],
    createdAt: iso(T0 - 86_400_000),
    updatedAt: iso(T0 - 86_400_000),
    ...over,
  };
}

export function run(id: number, over: Partial<Run> = {}): Run {
  return { id, workflow: 'CI', branch: 'dev', sha: 'b'.repeat(40), event: 'push', state: 'running', url: `https://github.com/o/r/actions/runs/${id}`, actor: 'alice', createdAt: iso(T0), updatedAt: iso(T0), ...over };
}

export function forge(over: Partial<ForgeState> = {}): ForgeState {
  return { repo: 'o/r', defaultBranch: 'dev', issues: [], pulls: [], runs: [], children: {}, polledAt: T0, ...over };
}
