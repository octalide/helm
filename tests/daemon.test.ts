import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { type HelmPaths, helmPaths } from '../src/core/paths.ts';
import type { GitHub } from '../src/daemon/github.ts';
import { Daemon } from '../src/daemon/helmd.ts';
import { T0, table } from './fixtures.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// a daemon over a scratch directory that never reaches github, with no timers
async function daemon(opts: { log?: (line: string) => void; gh?: GitHub } = {}): Promise<{ d: Daemon; paths: HelmPaths }> {
  const home = await mkdtemp(join(tmpdir(), 'helm-test-'));
  dirs.push(home);
  const gh = opts.gh ?? ({ rates: {} } as unknown as GitHub);
  const paths = helmPaths({ HOME: home, HELM_HOME: home });
  const d = new Daemon({ paths, config: DEFAULT_CONFIG, gh, version: '0', now: () => T0, loops: false, ...(opts.log ? { log: opts.log } : {}) });
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
    await d.stop();
  });
});
