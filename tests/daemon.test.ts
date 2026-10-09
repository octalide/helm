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
import { behindKey } from '../src/daemon/watch.ts';
import type { HelmEvent } from '../src/core/types.ts';
import { check, forge, pull, T0 } from './fixtures.ts';

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

  it('holds back ci on a head the subscriber has pushed past, and only that', async () => {
    // history runs stale -> old -> pushed, and other shares none of it
    const [stale, old, pushed, other] = ['b', 'a', 'c', 'd'].map((c) => c.repeat(40)) as [string, string, string, string];
    const history = [stale, old, pushed];
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
    expect((await wait('behind')).head).toBe(pushed);
    await wait('named', pushed.slice(0, 7));
    // a fork's origin/<head> is some other branch: no guess
    expect((await wait('fork', undefined, 151)).head).toBeUndefined();
    await wait('wins', old.slice(0, 7));
    remote = old;
    await wait('caught');
    // a local ref fetched long ago, or one the forge head does not descend from, says nothing
    remote = stale;
    await wait('fetched long ago');
    remote = other;
    await wait('unrelated');
    expect(Object.fromEntries(['behind', 'named', 'fork', 'wins', 'caught', 'fetched long ago', 'unrelated'].map((a) => [a, caught(a)]))).toEqual({ behind: false, named: false, fork: true, wins: true, caught: true, 'fetched long ago': true, unrelated: true });

    // live: ci on a head behind the expected one is held back, on that head or past it it goes through
    const live = (sha: string) => ({ id: `ci:${sha}`, kind: 'ci' as const, repo: 'o/r', at: T0, pr: 150, sha, tags: ['settled', 'success'], text: `ci settled success @${sha.slice(0, 7)}` });
    const held = (await (d as unknown as { staleHeads: (r: string, e: HelmEvent[]) => Promise<Set<string>> }).staleHeads('o/r', [live(old), live(pushed), live(other)]));
    expect([...held]).toEqual([behindKey(old, pushed), behindKey(old, pushed.slice(0, 7))]);
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
});
