import { workKey } from '../core/protocol.ts';
import { percent, rollupText } from '../core/tree.ts';
import type { HelmEvent, TreeNode } from '../core/types.ts';

// each issue anywhere under a root epic -> that root's key
export function rootsOf(tree: readonly TreeNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: TreeNode, root: string) => {
    out.set(workKey(n.repo, n.number), root);
    for (const c of n.children) walk(c, root);
  };
  for (const r of tree) walk(r, workKey(r.repo, r.number));
  return out;
}

const signature = (n: TreeNode) => JSON.stringify(n.rollup);

// one progress event per root epic whose rollup moved since the last look, carrying the phase changes under it.
// the first look only remembers, so a restart announces nothing
export function epicEvents(tree: readonly TreeNode[], before: ReadonlyMap<string, string> | undefined, changes: readonly HelmEvent[], now: number): { events: HelmEvent[]; seen: Map<string, string> } {
  const seen = new Map(tree.map((r) => [workKey(r.repo, r.number), signature(r)]));
  if (!before) return { events: [], seen };
  const roots = rootsOf(tree);
  const under = new Map<string, HelmEvent[]>();
  for (const e of changes) {
    const root = e.epic ?? (e.repo && e.issue !== undefined ? roots.get(workKey(e.repo, e.issue)) : undefined);
    if (root) under.set(root, [...(under.get(root) ?? []), e]);
  }
  const events: HelmEvent[] = [];
  for (const r of tree) {
    const key = workKey(r.repo, r.number);
    const sig = seen.get(key)!;
    if (before.get(key) === sig) continue;
    const complete = r.rollup.total > 0 && r.rollup.done === r.rollup.total;
    events.push({
      id: `epic:${key}:${sig}@${now}`,
      kind: 'epic',
      repo: r.repo,
      issue: r.number,
      at: now,
      tags: complete ? ['progress', 'complete'] : ['progress'],
      text: `${key} ${percent(r.rollup)}%: ${r.title}`,
      detail: [rollupText(r.rollup), ...(under.get(key) ?? []).map((e) => e.text)],
      ...(r.url ? { url: r.url } : {}),
    });
  }
  return { events, seen };
}
