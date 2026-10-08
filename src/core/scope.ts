import type { Scope, Subscription } from './types.ts';

// a scope as a tool or command spells it: repo, issue 12, pr 14, branch dev, run 123, tag v1.*, work, fleet
export function parseScope(text: string | undefined): Scope {
  const t = (text ?? 'repo').trim();
  const [kind = 'repo', ...rest] = t.split(/\s+/);
  const arg = rest.join(' ').replace(/^#/, '');
  const n = Number(arg);
  switch (kind) {
    case 'repo':
    case 'work':
    case 'fleet':
      return { kind };
    case 'issue':
    case 'pr':
      if (!Number.isInteger(n) || n <= 0) throw new Error(`scope ${kind} takes a number: ${kind} 12`);
      return { kind, number: n };
    case 'run':
      if (!Number.isInteger(n) || n <= 0) throw new Error('scope run takes a run id: run 123');
      return { kind, id: n };
    case 'branch':
      if (!arg) throw new Error('scope branch takes a name: branch dev');
      return { kind, name: arg };
    case 'tag':
      if (!arg) throw new Error('scope tag takes a glob: tag v1.*');
      return { kind, glob: arg };
    default:
      throw new Error(`unknown scope ${kind}: repo, issue <n>, pr <n>, branch <name>, run <id>, tag <glob>, work or fleet`);
  }
}

export function describeScope(s: Pick<Subscription, 'scope' | 'repo'>): string {
  const sc = s.scope;
  const where = s.repo ?? '';
  switch (sc.kind) {
    case 'repo':
      return where;
    case 'issue':
      return `${where} issue #${sc.number}`;
    case 'pr':
      return `${where} pr #${sc.number}`;
    case 'branch':
      return `${where} branch ${sc.name}`;
    case 'run':
      return `${where} run ${sc.id}`;
    case 'tag':
      return `${where} tag ${sc.glob}`;
    case 'work':
      return 'own work';
    case 'fleet':
      return 'fleet';
  }
}
