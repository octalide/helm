import type { Child, ForgeState, Issue, Phase, RepoName, Rollup, TreeNode, WorkView } from './types.ts';

const ACTIVE: ReadonlySet<Phase> = new Set(['working', 'draft', 'ci', 'ready']);
const ATTENTION: ReadonlySet<Phase> = new Set(['blocked', 'failing', 'stalled']);

const keyOf = (repo: RepoName, number: number) => `${repo}#${number}`;

export const emptyRollup = (): Rollup => ({ total: 0, done: 0, active: 0, attention: 0, ci: 0, ready: 0, queued: 0, unowned: 0 });

export function addRollup(into: Rollup, r: Rollup): Rollup {
  for (const k of Object.keys(into) as (keyof Rollup)[]) into[k] += r[k];
  return into;
}

// a share of the leaves that are done, 0 when there are none
export const percent = (r: Rollup): number => (r.total === 0 ? 0 : Math.round((100 * r.done) / r.total));

export function rollupText(r: Rollup): string {
  const parts = [`${r.done}/${r.total} done (${percent(r)}%)`, r.active ? `${r.active} active` : '', r.ci ? `${r.ci} in ci` : '', r.ready ? `${r.ready} ready` : '', r.attention ? `${r.attention} need attention` : '', r.queued ? `${r.queued} queued` : '', r.unowned ? `${r.unowned} unowned` : ''];
  return parts.filter(Boolean).join(' · ');
}

function leafRollup(state: 'open' | 'closed', phase: Phase | undefined, owned: boolean): Rollup {
  const r = emptyRollup();
  r.total = 1;
  if (state === 'closed' || phase === 'done') r.done = 1;
  else if (phase && ACTIVE.has(phase)) r.active = 1;
  else if (phase && ATTENTION.has(phase)) r.attention = 1;
  else if (phase === 'queued') r.queued = 1;
  if (phase === 'ci') r.ci = 1;
  if (phase === 'ready') r.ready = 1;
  if (r.done === 0 && !owned) r.unowned = 1;
  return r;
}

// the hierarchy of every watched repository as github's sub-issues draw it, each node joined to its work item.
// a root is an epic no epic here holds. a child in a repository helm does not poll is a leaf, or, when it has
// sub-issues of its own, an external node counted from its summary
export function buildTree(forges: readonly ForgeState[], work: readonly WorkView[]): TreeNode[] {
  const issues = new Map<string, Issue>();
  const children = new Map<string, Child[]>();
  for (const f of forges) {
    for (const i of f.issues) issues.set(keyOf(f.repo, i.number), i);
    for (const [n, list] of Object.entries(f.children ?? {})) children.set(keyOf(f.repo, Number(n)), list);
  }
  const works = new Map<string, WorkView>();
  for (const w of work) {
    const k = keyOf(w.repo, w.issue);
    const had = works.get(k);
    if (!had || had.queuedAt < w.queuedAt) works.set(k, w);
  }

  const held = new Set<string>();
  for (const [k, list] of children) for (const c of list) if (keyOf(c.repo, c.number) !== k) held.add(keyOf(c.repo, c.number));

  const node = (repo: RepoName, number: number, seen: ReadonlySet<string>, child?: Child): TreeNode => {
    const k = keyOf(repo, number);
    const issue = issues.get(k);
    const w = works.get(k);
    const state = issue?.state ?? child?.state ?? w?.issueState ?? 'open';
    const phase: Phase | undefined = w?.phase ?? (state === 'closed' ? 'done' : undefined);
    const list = seen.has(k) ? undefined : children.get(k);
    const summary = issue?.subIssues ?? child?.subIssues;
    const under = new Set(seen).add(k);
    const kids = (list ?? []).map((c) => node(c.repo, c.number, under, c));
    let rollup: Rollup;
    if (kids.length > 0) rollup = kids.reduce((r, c) => addRollup(r, c.rollup), emptyRollup());
    else if (!list && summary) {
      rollup = emptyRollup();
      rollup.total = summary.total;
      rollup.done = summary.done;
    } else rollup = leafRollup(state, phase, w !== undefined);
    const done = w?.plan?.filter((s) => s.done).length ?? 0;
    return {
      repo,
      number,
      title: issue?.title ?? child?.title ?? w?.title ?? '',
      url: issue?.url ?? child?.url ?? w?.issueUrl ?? '',
      state,
      ...(phase ? { phase } : {}),
      ...(w?.owner ? { owner: w.owner } : {}),
      ...(w?.agent ? { agent: w.agent } : {}),
      ...(w?.routing ? { tier: w.routing.tier } : {}),
      ...(w?.plan?.length ? { plan: { done, total: w.plan.length } } : {}),
      ...(!list && summary ? { external: true } : {}),
      children: kids,
      rollup,
    };
  };

  const roots: TreeNode[] = [];
  for (const f of forges) {
    for (const i of f.issues) {
      if (i.state !== 'open' || !i.subIssues) continue;
      if (held.has(keyOf(f.repo, i.number))) continue;
      roots.push(node(f.repo, i.number, new Set()));
    }
  }
  return roots.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}

// the node for an issue anywhere in the tree, with the path of its ancestors from the root
export function findNode(tree: readonly TreeNode[], repo: RepoName, number: number): { node: TreeNode; path: TreeNode[] } | undefined {
  const walk = (n: TreeNode, path: TreeNode[]): { node: TreeNode; path: TreeNode[] } | undefined => {
    if (n.repo === repo && n.number === number) return { node: n, path };
    for (const c of n.children) {
      const hit = walk(c, [...path, n]);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const r of tree) {
    const hit = walk(r, []);
    if (hit) return hit;
  }
  return undefined;
}
