import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { helmPaths } from '../src/core/paths.ts';
import type { GitHub } from '../src/daemon/github.ts';
import { Daemon } from '../src/daemon/helmd.ts';
import { T0 } from './fixtures.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// a daemon over a scratch directory that never reaches github, with no timers
async function daemon(gh = { rates: {} } as unknown as GitHub): Promise<Daemon> {
  const home = await mkdtemp(join(tmpdir(), 'helm-test-'));
  dirs.push(home);
  const d = new Daemon({ paths: helmPaths({ HOME: home, HELM_HOME: home }), config: DEFAULT_CONFIG, gh, version: '0', now: () => T0, loops: false });
  await d.start();
  return d;
}

const lettersFor = (d: Daemon, session: string, agent?: string) => Object.values(d.ledger.data.letters).filter((l) => l.session === session && l.agent === agent);

describe('daemon', () => {
  it('hands an answer to the session that asked once, and the event to everyone else', async () => {
    const d = await daemon();
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

  it('polls a repository at once when an agent reports on its work', async () => {
    const asked: string[] = [];
    const gh = {
      rates: {},
      conditional: async (path: string) => {
        asked.push(path);
        throw new Error('offline');
      },
    } as unknown as GitHub;
    const d = await daemon(gh);
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    d.report({ session: 'A', agent: 'x', repo: 'o/r', issue: 1, state: 'ready' });
    await vi.waitFor(() => expect(asked.some((p) => p.startsWith('repos/o/r/'))).toBe(true));
    await d.stop();
  });

  it('still tells the main loop when the answer went to one of its agents', async () => {
    const d = await daemon();
    d.register({ id: 'A', cwd: '/', repo: 'o/r' });
    d.ledger.claim({ session: 'A', repo: 'o/r', issue: 1, agent: 'x' }, 'one');
    const q = d.decide({ kind: 'question', repo: 'o/r', issue: 1, title: 'which', body: '', blocking: true, from: { session: 'A', agent: 'x' } });
    d.answer(q.id, { text: 'this', by: 'human' });
    expect(lettersFor(d, 'A', 'x').map((l) => l.text.split('\n')[0])).toEqual([`[helm decision ${q.id} answered by human] which`]);
    expect(lettersFor(d, 'A').some((l) => l.text.includes(`decision ${q.id} answered by human`))).toBe(true);
    await d.stop();
  });
});
