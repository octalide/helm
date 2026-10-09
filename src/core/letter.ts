import { workKey } from './protocol.ts';
import type { HelmEvent, Letter, LetterPart } from './types.ts';

// an event as a letter lists it: its line, its detail indented, then where to look and which subscriptions took it
export function eventPart(e: HelmEvent, subs: readonly string[]): LetterPart {
  const phase = e.phase && e.kind === 'work' && e.repo && e.issue !== undefined ? { key: workKey(e.repo, e.issue), path: [e.phase.from, e.phase.to], title: e.phase.title } : undefined;
  return {
    head: e.kind === 'work' || e.kind === 'decision' || e.kind === 'epic' ? e.kind : (e.repo ?? 'helm'),
    lines: [phase ? phaseLine(phase) : e.text, ...(e.detail ?? []).map((d) => `  ${d}`), `  ${[e.url, subs.join(' ')].filter(Boolean).join(' · ')}`],
    ...(phase ? { phase } : {}),
  };
}

const phaseLine = (p: NonNullable<LetterPart['phase']>): string => `${p.key} ${p.path.join(' → ')}: ${p.title}`;

// the parts of a letter, or of letters delivered together, a work item's older phases folded into its newest: the
// newest part stands where it falls, its path led by the phases before it
export function fold(parts: readonly LetterPart[]): LetterPart[] {
  const out: LetterPart[] = [];
  const at = new Map<string, number>();
  for (const p of parts) {
    const key = p.phase?.key;
    const was = key === undefined ? undefined : at.get(key);
    if (key === undefined || was === undefined) {
      if (key !== undefined) at.set(key, out.length);
      out.push(p);
      continue;
    }
    const older = out[was]!.phase!;
    const path = older.path.at(-1) === p.phase!.path[0] ? [...older.path, ...p.phase!.path.slice(1)] : [...older.path, ...p.phase!.path];
    const phase = { ...p.phase!, path };
    out.splice(was, 1);
    for (const [k, i] of at) if (i > was) at.set(k, i - 1);
    at.set(key, out.length);
    out.push({ ...p, lines: [phaseLine(phase), ...p.lines.slice(1)], phase });
  }
  return out;
}

// grouped under a header per head, in the order heads first appear; a part with no head stands as its own block
export function letterText(parts: readonly LetterPart[]): string {
  const blocks: string[][] = [];
  const groups = new Map<string, string[]>();
  for (const p of parts) {
    if (p.head === undefined) {
      blocks.push([...p.lines]);
      continue;
    }
    const group = groups.get(p.head);
    if (group) group.push(...p.lines);
    else {
      const fresh = [`[helm ${p.head}]`, ...p.lines];
      groups.set(p.head, fresh);
      blocks.push(fresh);
    }
  }
  return blocks.map((b) => b.join('\n')).join('\n\n');
}

// what letters delivered together read as: one text, stale phases folded
export function deliveryText(letters: readonly Letter[]): string {
  return letterText(fold(letters.flatMap((l): LetterPart[] => l.parts ?? [{ lines: [l.text] }])));
}
