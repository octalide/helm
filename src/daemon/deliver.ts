import type { HelmEvent, Letter, Subscription } from '../core/types.ts';
import { expired, type MatchContext, matches, retiredBy } from './watch.ts';

export type Routed = { letters: Omit<Letter, 'id' | 'at'>[]; retired: string[] };

// one batch of events to the subscriptions that take them: one letter per recipient (a session's main loop, or one
// agent of it), each event once however many of its subscriptions took it, each subscription that ran its course retired
export function route(events: readonly HelmEvent[], subs: readonly Subscription[], ctx: MatchContext, now: number): Routed {
  const live = subs.filter((s) => !expired(s, now));
  const retired = new Set(subs.filter((s) => expired(s, now)).map((s) => s.id));
  const byRecipient = new Map<string, { session: string; agent?: string; items: { event: HelmEvent; subs: string[] }[] }>();
  for (const e of events) {
    const takers = new Map<string, string[]>();
    for (const s of live) {
      if (retired.has(s.id) || !matches(e, s, ctx)) continue;
      const key = `${s.session}\u0000${s.agent ?? ''}`;
      takers.set(key, [...(takers.get(key) ?? []), s.id]);
      if (retiredBy(e, s)) retired.add(s.id);
    }
    for (const [key, ids] of takers) {
      const [session, agent] = key.split('\u0000') as [string, string];
      const box = byRecipient.get(key) ?? { session, ...(agent ? { agent } : {}), items: [] };
      box.items.push({ event: e, subs: ids });
      byRecipient.set(key, box);
    }
  }
  const letters = [...byRecipient.values()].map((box) => ({
    session: box.session,
    ...(box.agent ? { agent: box.agent } : {}),
    text: letterText(box.items),
    events: box.items.map((i) => i.event.id),
    subs: [...new Set(box.items.flatMap((i) => i.subs))],
  }));
  return { letters, retired: [...retired] };
}

// grouped under a header per repository, each event its line, its detail indented, then where to look and which
// subscriptions took it
export function letterText(items: readonly { event: HelmEvent; subs: string[] }[]): string {
  const groups = new Map<string, string[]>();
  for (const { event: e, subs } of items) {
    const head = e.kind === 'work' ? 'work' : e.kind === 'decision' ? 'decision' : (e.repo ?? 'helm');
    const lines = groups.get(head) ?? [];
    lines.push(e.text);
    for (const d of e.detail ?? []) lines.push(`  ${d}`);
    lines.push(`  ${[e.url, subs.join(' ')].filter(Boolean).join(' · ')}`);
    groups.set(head, lines);
  }
  return [...groups].map(([head, lines]) => [`[helm ${head}]`, ...lines].join('\n')).join('\n\n');
}
