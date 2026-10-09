import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { type HelmPaths, helmPaths } from '../src/core/paths.ts';
import type { GitHub } from '../src/daemon/github.ts';
import { Daemon } from '../src/daemon/helmd.ts';
import type { Git } from '../src/daemon/local.ts';
import { emptyCache } from '../src/daemon/poller.ts';
import { heldKey } from '../src/daemon/watch.ts';
import type { HelmEvent } from '../src/core/types.ts';
import { check, forge, pull, T0, table } from './fixtures.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// a daemon over a scratch directory that never reaches github, with no timers
async function daemon(opts: { log?: (line: string) => void; gh?: GitHub; git?: Git; setup?: (home: string, paths: HelmPaths) => Promise<void> } = {}): Promise<{ d: Daemon; paths: HelmPaths }> {
  const home = await mkdtemp(join(tmpdir(), 'helm-test-'));
  dirs.push(home);
  const gh = opts.gh ?? ({ rates: {} } as unknown as GitHub);
  const paths = helmPaths({ HOME: home, HELM_HOME: home });
  await opts.setup?.(home, paths);
  const config = { ...DEFAULT_CONFIG, roots: [join(home, 'src')] };
  const d = new Daemon({ paths, config, gh, version: '0', now: () => T0, loops: false, ...(opts.log ? { log: opts.log } : {}), ...(opts.git ? { git: opts.git } : {}) });
  await d.start();
  return { d, paths };
}

const lettersFor = (d: Daemon, session: string, agent?: string) => Object.values(d.ledger.data.letters).filter((l) => l.session === session && l.agent === agent);

describe('daemon', () => {
  it('hands an answer to the session that asked once, and the event to everyone else', async () => {
    const { d } = await daemon();
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    d.register({ id: 'C', cwd: '/', role: 'coordinator' });
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 1 }, 'one');
    const q = d.decide({ kind: 'choice', repo: 'o/r', issue: 1, title: 'a call', body: '', blocking: false, from: { session: 'A' } });
    const before = lettersFor(d, 'A').length;
    d.answer(q.id, { text: 'fine', by: 'human' });
    const mine = lettersFor(d, 'A').slice(before);
    expect(mine.map((l) => l.text.split('\n')[0])).toEqual([`[helm decision ${q.id} answered by human] a call`]);
    expect(lettersFor(d, 'C').some((l) => l.text.includes(`decision ${q.id} answered by human`))).toBe(true);
    await d.stop();
  });

  it('tells the fleet of a decision once it is the person\'s, not while a session holds it', async () => {
    const { d } = await daemon();
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    d.register({ id: 'C', cwd: '/', role: 'coordinator' });
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const heard = () => lettersFor(d, 'C').map((l) => l.text).join('\n');
    const q = d.decide({ kind: 'question', repo: 'o/r', issue: 1, title: 'which', body: '', blocking: true, from: { session: 'A', agent: 'x' } });
    expect(heard()).not.toContain(`decision ${q.id} `);
    d.escalate(q.id, { by: 'session A', note: 'needs the person' });
    expect(heard()).toContain(`decision ${q.id} escalated to the person by session A (question) o/r#1: which\n  needs the person`);
    const s = d.decide({ kind: 'stall', repo: 'o/r', issue: 1, title: 'stalled', body: '', blocking: false });
    expect(s.to).toBe('session');
    d.endSession('A');
    expect(d.ledger.data.decisions[s.id]!.to).toBe('person');
    expect(heard()).toContain(`decision ${s.id} escalated to the person by helm (stall)`);
    await d.stop();
  });

  it('titles a claim by the issue the caller read when the forge cache has not seen it', async () => {
    const { d } = await daemon();
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    expect(d.claim({ session: 'A', repo: 'o/r', issue: 7, title: 'fresh issue' }).title).toBe('fresh issue');
    await d.stop();
  });

  it('polls a repository at once when an agent reports on its work', async () => {
    const asked: string[] = [];
    const gh = {
      rates: {},
      conditional: async (path: string) => {
        asked.push(path);
        throw new Error('offline');
      },
    } as unknown as GitHub;
    const { d } = await daemon({ gh });
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    d.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'ready' });
    await vi.waitFor(() => expect(asked.some((p) => p.startsWith('repos/o/r/'))).toBe(true));
    await d.stop();
  });

  it('still tells the main loop when the answer went to one of its agents', async () => {
    const { d } = await daemon();
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const q = d.decide({ kind: 'question', repo: 'o/r', issue: 1, title: 'which', body: '', blocking: true, from: { session: 'A', agent: 'x' } });
    d.answer(q.id, { text: 'this', by: 'human' });
    expect(lettersFor(d, 'A', 'x').map((l) => l.text.split('\n')[0])).toEqual([`[helm decision ${q.id} answered by human] which`]);
    expect(lettersFor(d, 'A').some((l) => l.text.includes(`decision ${q.id} answered by human`))).toBe(true);
    await d.stop();
  });

  it('holds back ci on a head other than the one the subscriber waits on', async () => {
    // history runs stale -> old -> pushed -> later, and rebased shares none of it
    const [stale, old, pushed, later, rebased] = ['b', 'a', 'c', 'e', 'd'].map((c) => c.repeat(40)) as [string, string, string, string, string];
    const history = [stale, old, pushed, later];
    const offline = { rates: {}, conditional: async () => Promise.reject(new Error('offline')) } as unknown as GitHub;
    let remote = pushed;
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'config') return 'git@github.com:o/r.git\n';
      if (args[0] === 'for-each-ref' && args.at(-1)?.startsWith('refs/remotes/origin/')) return `${args.at(-1)}\t${remote}\t1\n`;
      if (args[0] === 'merge-base') {
        const [a, b] = [history.findIndex((h) => h.startsWith(args[2]!)), history.findIndex((h) => h.startsWith(args[3]!))];
        if (a < 0 || b < 0 || a > b) throw new Error('not an ancestor');
      }
      return '';
    };
    const green = [check('test', 'success')];
    const { d } = await daemon({
      gh: offline,
      git,
      setup: async (home, paths) => {
        await mkdir(join(home, 'src', 'r', '.git'), { recursive: true });
        await mkdir(paths.repos, { recursive: true });
        const settled = forge({ pulls: [pull(150, { sha: old, checks: green }), pull(151, { sha: old, checks: green, fork: true })] });
        await writeFile(join(paths.repos, 'o__r.json'), JSON.stringify({ ...emptyCache(), forge: settled }));
      },
    });
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    const wait = (agent: string, sha?: string, number = 150) => d.subscribe({ session: 'A', agent, repo: 'o/r', scope: { kind: 'pr', number }, ci: 'settled', until: 'settled', ...(sha ? { sha } : {}) });
    const caught = (agent: string) => lettersFor(d, 'A', agent).some((l) => l.text.includes('ci settled success'));

    // the forge still shows old, the push made pushed: held back, from the local ref or a named sha
    const guessed = await wait('guessed');
    expect([guessed.head, guessed.named]).toEqual([pushed, undefined]);
    const named = await wait('named', pushed.slice(0, 7));
    expect([named.head, named.named]).toEqual([pushed.slice(0, 7), true]);
    // a force push: the forge's pre-rebase head is no part of the named one
    const forced = await wait('force pushed', rebased);
    // a fork's origin/<head> is some other branch: no guess
    expect((await wait('fork', undefined, 151)).head).toBeUndefined();
    await wait('matches', old.slice(0, 7));
    // the forge head is past the named one: pushed on top since
    await wait('pushed on top', stale);
    remote = old;
    await wait('caught');
    // a local ref fetched long ago, or one the forge head does not descend from, says nothing
    remote = stale;
    await wait('fetched long ago');
    remote = rebased;
    await wait('unrelated');
    const agents = ['guessed', 'named', 'force pushed', 'fork', 'matches', 'pushed on top', 'caught', 'fetched long ago', 'unrelated'];
    expect(agents.filter(caught)).toEqual(['fork', 'matches', 'pushed on top', 'caught', 'fetched long ago', 'unrelated']);

    // live: a guessed head holds back only what it strictly descends from, a named one all but itself and what follows
    const live = (sha: string) => ({ id: `ci:${sha}`, kind: 'ci' as const, repo: 'o/r', at: T0, pr: 150, sha, tags: ['settled', 'success'], text: `ci settled success @${sha.slice(0, 7)}` });
    const held = await (d as unknown as { heldHeads: (r: string, e: HelmEvent[]) => Promise<Set<string>> }).heldHeads('o/r', [old, pushed, later, rebased].map(live));
    const of = (id: string) => [old, pushed, later, rebased].filter((sha) => held.has(heldKey(id, sha)));
    expect([of(guessed.id), of(named.id), of(forced.id)]).toEqual([[old], [old, rebased], [old, pushed, later]]);
    await d.stop();
  });

  it('applies an edited config live and keeps the running one through a broken edit', async () => {
    const log: string[] = [];
    const { d, paths } = await daemon({ log: (line) => log.push(line) });
    const file = join(paths.config, 'config.json');
    await mkdir(paths.config, { recursive: true });
    await writeFile(file, JSON.stringify({ routing: { fallback: 'deep' } }));
    await d.reloadConfig();
    expect((await d.configFor()).routing.fallback).toBe('deep');
    await writeFile(file, JSON.stringify({ routing: { fallback: 'huge' } }));
    await d.reloadConfig();
    expect((await d.configFor()).routing.fallback).toBe('deep');
    expect(log.at(-1)).toMatch(/keeping the running one: .*names no tier/);
    await d.stop();
  });

  it('reports what an ended agent left running in its worktree, and kills nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'helm-test-'));
    dirs.push(home);
    const repo = join(home, 'src', 'r');
    const wt = join(repo, '.claude', 'worktrees', 'fix', '7');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(wt, { recursive: true });
    const git = async (_cwd: string, args: string[]) => {
      if (args[0] === 'config') return 'git@github.com:o/r.git';
      if (args[0] === 'worktree') return `worktree ${repo}\nHEAD a\nbranch refs/heads/dev\n\nworktree ${wt}\nHEAD b\nbranch refs/heads/fix/7\n`;
      return '';
    };
    const gh = { rates: {}, conditional: async () => Promise.reject(new Error('offline')) } as unknown as GitHub;
    const procs = table({ 40: [wt, 'sh -c until false; do :; done'], 41: [repo, 'claude'] });
    const d = new Daemon({ paths: helmPaths({ HOME: home, HELM_HOME: home }), config: { ...DEFAULT_CONFIG, roots: [join(home, 'src')] }, gh, version: '0', now: () => T0, loops: false, git, procs });
    await d.start();
    d.register({ id: 'A', cwd: repo, repo: 'o/r' });
    await d.ask('o/r');
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 7, agent: 'x' }, 'seven');
    const agent = { id: 'x', type: 'issue', description: '' };
    d.heartbeat('A', [{ ...agent, status: 'running' }]);
    d.heartbeat('A', [{ ...agent, status: 'completed' }]);
    await vi.waitFor(() => expect(d.ledger.data.work['o/r#7']?.leftovers).toEqual([{ pid: 40, command: 'sh -c until false; do :; done' }]));
    expect(lettersFor(d, 'A').some((l) => l.text.includes('agent x ended and left 1 process running') && l.text.includes('pid 40'))).toBe(true);
    await d.recheckLeftovers();
    expect(d.ledger.data.work['o/r#7']?.leftovers).toHaveLength(1);
    delete procs.live[40];
    await d.recheckLeftovers();
    expect(d.ledger.data.work['o/r#7']?.leftovers).toBeUndefined();
    await d.stop();
  });
});
