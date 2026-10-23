import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Leftover } from '../core/types.ts';

// what the scan reads of a process table: linux /proc by default, stubbed in tests
export type ProcTable = {
  pids(): Promise<number[]>;
  // undefined for a process gone or not readable by this user
  cwd(pid: number): Promise<string | undefined>;
  command(pid: number): Promise<string | undefined>;
};

export const procfs = (root = '/proc'): ProcTable => ({
  // a host without /proc lists nothing
  pids: async () => (await readdir(root).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).map(Number),
  cwd: (pid) => readlink(`${root}/${pid}/cwd`).catch(() => undefined),
  command: async (pid) => {
    const raw = await readFile(`${root}/${pid}/cmdline`, 'utf8').catch(() => undefined);
    return raw === undefined ? undefined : raw.replace(/\0+$/, '').replaceAll('\0', ' ');
  },
});

export function inside(dir: string, path: string): boolean {
  const root = dir.replace(/\/+$/, '');
  return path === root || path.startsWith(`${root}/`);
}

// helm's own session stream (`main.ts stream <session>`): it belongs to the session, never to an agent
const STREAM = /\/daemon\/main\.ts stream \S+$/;

// live processes whose working directory is inside a directory, never this process itself
export async function leftovers(dir: string, table: ProcTable = procfs(), self = process.pid): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (const pid of await table.pids()) {
    if (pid === self) continue;
    const cwd = await table.cwd(pid);
    if (cwd === undefined || !inside(dir, cwd)) continue;
    const command = await table.command(pid);
    // a zombie has an empty cmdline: nothing left running
    if (command && !STREAM.test(command)) out.push({ pid, command });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// the listed processes still running as listed: the same pid on the same command, its cwd still inside the directory
// when there is one to hold it to
export async function still(listed: readonly Leftover[], dir: string | undefined, table: ProcTable = procfs()): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (const p of listed) {
    const cwd = await table.cwd(p.pid);
    if (cwd === undefined || (dir !== undefined && !inside(dir, cwd))) continue;
    if ((await table.command(p.pid)) === p.command) out.push(p);
  }
  return out;
}

// an interactive claude process as its own session file tells it: claude keeps one per process, <pid>.json under
// its config directory's sessions/, naming the conversation it is in (a fresh id until one is picked or started)
export type ClaudeProcess = { pid: number; session: string; cwd: string; startedAt?: number };

export type ClaudeProcesses = () => Promise<ClaudeProcess[]>;

export const claudeSessionsDir = (env: NodeJS.ProcessEnv = process.env): string => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');

// the session files in a directory, live or not; a print or sdk run is no session a person waits on, and is left out
export const claudeProcesses = (dir = claudeSessionsDir()): ClaudeProcesses => async () => {
  const out: ClaudeProcess[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^\d+\.json$/.test(name)) continue;
    const raw = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    let f: { pid?: unknown; sessionId?: unknown; cwd?: unknown; kind?: unknown; startedAt?: unknown };
    try {
      f = raw === undefined ? {} : JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof f.pid !== 'number' || typeof f.sessionId !== 'string' || typeof f.cwd !== 'string' || f.kind !== 'interactive') continue;
    out.push({ pid: f.pid, session: f.sessionId, cwd: f.cwd, ...(typeof f.startedAt === 'number' ? { startedAt: f.startedAt } : {}) });
  }
  return out.sort((a, b) => a.pid - b.pid);
};

// the claude processes still running where their file says, so a file left behind by one that died, or a pid taken
// by another process since, is not read as live. the table names a directory with its links resolved
export async function running(found: readonly ClaudeProcess[], table: ProcTable = procfs()): Promise<ClaudeProcess[]> {
  const out: ClaudeProcess[] = [];
  for (const p of found) {
    const cwd = await table.cwd(p.pid);
    if (cwd !== undefined && (cwd === p.cwd || cwd === (await realpath(p.cwd).catch(() => p.cwd)))) out.push(p);
  }
  return out;
}
