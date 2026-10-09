import { describe, expect, it } from 'vitest';
import { mergeConfig, DEFAULT_CONFIG } from '../src/core/config.ts';
import { trimLog } from '../src/daemon/helmd.ts';
import { repoOfRemote } from '../src/core/repo.ts';
import { parseBranches, parseStatus, parseWorktrees } from '../src/daemon/local.ts';
import { daemonAction } from '../src/core/protocol.ts';
import { leftovers } from '../src/daemon/procs.ts';
import { table } from './fixtures.ts';

describe('local git parsing', () => {
  it('reads remotes in every spelling', () => {
    expect(repoOfRemote('git@github.com:octalide/helm.git')).toBe('octalide/helm');
    expect(repoOfRemote('https://github.com/briar-systems/mach')).toBe('briar-systems/mach');
    expect(repoOfRemote('https://gitlab.com/a/b')).toBeUndefined();
  });

  it('reads worktrees, status and branches', () => {
    const wts = parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/dev\n\nworktree /r/wt\nHEAD def\nbranch refs/heads/feat/2\nlocked\n');
    expect(wts).toEqual([
      { path: '/r', sha: 'abc', main: true, branch: 'dev' },
      { path: '/r/wt', sha: 'def', main: false, branch: 'feat/2', locked: true },
    ]);
    expect(parseStatus('# branch.oid x\n# branch.upstream origin/dev\n# branch.ab +2 -1\n1 .M N... a\n? new\n')).toEqual({ dirty: 2, upstream: 'origin/dev', ahead: 2, behind: 1 });
    expect(parseBranches('dev\tabc\torigin/dev\tbehind 3\t100\nold\tdef\torigin/old\tgone\t50\n')).toEqual([
      { name: 'dev', sha: 'abc', committedAt: 100_000, upstream: 'origin/dev', behind: 3 },
      { name: 'old', sha: 'def', committedAt: 50_000, upstream: 'origin/old', gone: true },
    ]);
  });
});

describe('config and logs', () => {
  it('merges layers and refuses a malformed tier or a fallback that names no tier', () => {
    const c = mergeConfig(DEFAULT_CONFIG, { poll: { active: 5 } });
    expect(c.poll).toEqual({ ...DEFAULT_CONFIG.poll, active: 5 });
    expect(() => mergeConfig(DEFAULT_CONFIG, { routing: { tiers: [{ name: 'x' }] } })).toThrow(/needs name/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { routing: { fallback: 'huge' } })).toThrow('routing.fallback "huge" names no tier; the tiers are mechanical, light, standard, deep, frontier');
  });

  it('keeps error lines with their lead-up', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `2026-10-01T00:00:00.0000000Z line ${i}`).join('\n') + '\n2026-10-01T00:00:00.0000000Z ##[error]boom';
    const out = trimLog(raw, { errors: true }).split('\n');
    expect(out.at(-1)).toBe('##[error]boom');
    expect(out[0]).toBe('… (line 81)');
  });

  it('finds the processes left inside a worktree and nothing beside it', async () => {
    const procs = table({
      10: ['/r/.claude/worktrees/fix/61', 'bash -c until [ -s out.log ]; do :; done'],
      11: ['/r/.claude/worktrees/fix/61/web', 'node serve.js'],
      12: ['/r/.claude/worktrees/fix/610', 'vitest'],
      13: ['/r', 'claude'],
      14: [undefined, 'not mine'],
      15: ['/r/.claude/worktrees/fix/61', ''],
      16: ['/r/.claude/worktrees/fix/61', 'helmd'],
    });
    expect(await leftovers('/r/.claude/worktrees/fix/61/', procs, 16)).toEqual([
      { pid: 10, command: 'bash -c until [ -s out.log ]; do :; done' },
      { pid: 11, command: 'node serve.js' },
    ]);
  });
});

describe('daemon replacement', () => {
  it('replaces only an older helmd and leaves a newer protocol for a reload', () => {
    expect(daemonAction(undefined, '0.4.0', 2)).toBe('start');
    expect(daemonAction({ version: '0.3.0', protocol: 1 }, '0.4.0', 2)).toBe('restart');
    expect(daemonAction({ version: '0.3.9', protocol: 2 }, '0.4.0', 2)).toBe('restart');
    expect(daemonAction({ version: '0.4.0', protocol: 2 }, '0.4.0', 2)).toBe('use');
    expect(daemonAction({ version: '0.5.0', protocol: 2 }, '0.4.0', 2)).toBe('use');
    expect(daemonAction({ version: '0.4.0', protocol: 2 }, '0.3.0', 1)).toBe('reload');
  });
});
