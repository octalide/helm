import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Branch, LocalState, RepoName, Worktree } from '../core/types.ts';

const exec = promisify(execFile);

export type Git = (cwd: string, args: string[]) => Promise<string>;

export const git: Git = async (cwd, args) => {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return stdout;
};

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p);
}

// owner/name of a github remote url in any of its spellings
export function repoOfRemote(url: string): RepoName | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

const SKIP = new Set(['node_modules', '.cache', 'target', 'build', 'dist', 'out', '.worktrees', 'worktrees']);

// every main checkout under the roots, by the repository its origin names. a linked worktree (.git a file) is found
// through its main checkout's worktree list, not here
export async function discover(roots: string[], run: Git = git, depth = 4): Promise<Map<RepoName, string[]>> {
  const found = new Map<RepoName, string[]>();
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git' && e.isDirectory())) {
      const url = await run(dir, ['config', '--get', 'remote.origin.url']).catch(() => '');
      const repo = repoOfRemote(url);
      if (repo) found.set(repo, [...(found.get(repo) ?? []), dir]);
      return;
    }
    if (left === 0) return;
    await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => walk(join(dir, e.name), left - 1)));
  };
  await Promise.all(roots.map((r) => walk(expandHome(r), depth)));
  return found;
}

export function parseWorktrees(porcelain: string): Omit<Worktree, 'dirty'>[] {
  const out: Omit<Worktree, 'dirty'>[] = [];
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const sha = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '';
    const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '');
    if (lines.includes('bare')) continue;
    out.push({ path, sha, main: out.length === 0, ...(branch ? { branch } : {}), ...(lines.some((l) => l.startsWith('locked')) ? { locked: true } : {}) });
  }
  return out;
}

// porcelain v2 with --branch: the upstream, ahead and behind headers, then one line per changed path
export function parseStatus(text: string): Pick<Worktree, 'dirty' | 'ahead' | 'behind' | 'upstream'> {
  let dirty = 0;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (!line.startsWith('#')) dirty++;
  }
  return { dirty, ...(upstream ? { upstream } : {}), ...(ahead !== undefined ? { ahead, behind } : {}) };
}

const REF_FORMAT = '%(refname:short)%09%(objectname)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(committerdate:unix)';

export function parseBranches(text: string): Branch[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', sha = '', upstream = '', track = '', date = '0'] = line.split('\t');
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      return {
        name,
        sha,
        committedAt: Number(date) * 1000,
        ...(upstream ? { upstream } : {}),
        ...(ahead ? { ahead: Number(ahead[1]) } : {}),
        ...(behind ? { behind: Number(behind[1]) } : {}),
        ...(track === 'gone' ? { gone: true } : {}),
      };
    });
}

// worktrees and branches of every checkout of one repository
export async function scan(repo: RepoName, checkouts: string[], now: number, run: Git = git): Promise<LocalState> {
  const worktrees: Worktree[] = [];
  const branches = new Map<string, Branch>();
  for (const checkout of checkouts) {
    const listed = parseWorktrees(await run(checkout, ['worktree', 'list', '--porcelain']).catch(() => ''));
    for (const wt of listed) {
      const alive = await stat(wt.path).then(() => true, () => false);
      if (!alive) continue;
      const status = await run(wt.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']).catch(() => undefined);
      worktrees.push({ ...wt, main: wt.main && checkout === checkouts[0], ...(status === undefined ? { dirty: 0 } : parseStatus(status)) });
    }
    for (const b of parseBranches(await run(checkout, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads']).catch(() => ''))) {
      if (!branches.has(b.name)) branches.set(b.name, b);
    }
  }
  return { repo, checkouts, worktrees, branches: [...branches.values()].sort((a, b) => b.committedAt - a.committedAt), scannedAt: now };
}
