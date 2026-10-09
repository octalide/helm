import { readdir, readFile, readlink } from 'node:fs/promises';
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

// live processes whose working directory is inside a directory, never this process itself
export async function leftovers(dir: string, table: ProcTable = procfs(), self = process.pid): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (const pid of await table.pids()) {
    if (pid === self) continue;
    const cwd = await table.cwd(pid);
    if (cwd === undefined || !inside(dir, cwd)) continue;
    const command = await table.command(pid);
    // a zombie has an empty cmdline: nothing left running
    if (command) out.push({ pid, command });
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
