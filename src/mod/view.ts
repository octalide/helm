import { isDone } from '../core/checks.ts';
import type { Decision, Fleet, Phase, SessionRole, WorkView } from '../core/types.ts';
import { ago, jobLine } from './format.ts';

// what a surface draws: rows of styled segments, so the drawing is plain data the hooks module maps onto elements
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean };
export type Row = Seg[];

export type Self = { session: string; role: SessionRole; repo?: string };

const PHASE_COLOR: Record<Phase, string> = {
  queued: 'inactive',
  working: 'claude',
  draft: 'suggestion',
  ci: 'warning',
  failing: 'error',
  ready: 'success',
  blocked: 'error',
  stalled: 'warning',
  done: 'inactive',
};

// the order work is listed in: what needs someone first, then what moves, then what waits
const PHASE_RANK: Record<Phase, number> = { blocked: 0, failing: 1, stalled: 2, ci: 3, ready: 4, draft: 5, working: 6, queued: 7, done: 8 };

const short = (model: string) => model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');

export function counts(work: readonly WorkView[], decisions: readonly Decision[]) {
  const open = work.filter((w) => w.phase !== 'done');
  return {
    active: open.filter((w) => w.phase !== 'queued').length,
    queued: open.filter((w) => w.phase === 'queued').length,
    ci: open.filter((w) => w.phase === 'ci').length,
    attention: open.filter((w) => w.phase === 'blocked' || w.phase === 'failing' || w.phase === 'stalled').length,
    waiting: decisions.filter((d) => d.state === 'open' && d.blocking).length,
    review: decisions.filter((d) => d.state === 'open' && !d.blocking).length,
  };
}

function summary(c: ReturnType<typeof counts>): Row {
  const row: Row = [{ text: `${c.active} active`, bold: true }];
  if (c.queued) row.push({ text: ` · ${c.queued} queued`, dim: true });
  if (c.ci) row.push({ text: ` · ${c.ci} in ci`, color: 'warning' });
  if (c.attention) row.push({ text: ` · ${c.attention} need attention`, color: 'error' });
  if (c.waiting) row.push({ text: ` · ${c.waiting} waiting on a decision`, color: 'error', bold: true });
  if (c.review) row.push({ text: ` · ${c.review} for review`, dim: true });
  return row;
}

function workRows(w: WorkView, wide: boolean): Row[] {
  const head: Row = [
    { text: `${w.phase.padEnd(8)}`, color: PHASE_COLOR[w.phase], bold: w.phase === 'blocked' },
    { text: ` #${w.issue} `, bold: true },
    { text: w.title },
  ];
  const meta: string[] = [];
  if (w.routing) meta.push(`${short(w.routing.model)}/${w.routing.effort}`);
  if (w.pull) meta.push(`pr #${w.pull.number}${w.pull.draft ? ' draft' : ''}`);
  if (w.checks.length) meta.push(`ci ${w.checks.filter((c) => isDone(c.state)).length}/${w.checks.length}`);
  if (w.worktree?.dirty) meta.push(`dirty ${w.worktree.dirty}`);
  if (w.decisions) meta.push(`${w.decisions} decision${w.decisions === 1 ? '' : 's'}`);
  const rows: Row[] = [head];
  if (meta.length || w.report?.note) rows.push([{ text: `         ${meta.join(' · ')}${w.report?.note ? `${meta.length ? ' · ' : ''}${w.report.note}` : ''}`, dim: true }]);
  if (wide) for (const j of w.jobs.filter((x) => !isDone(x.state) || x.state === 'failure')) rows.push([{ text: `         ${isDone(j.state) ? '✗' : '▸'} ${jobLine(j)}`, color: isDone(j.state) ? 'error' : 'warning' }]);
  return rows;
}

function decisionRow(d: Decision, now: number): Row {
  return [
    { text: `${d.id.padEnd(4)} `, dim: true },
    { text: d.blocking ? 'waiting ' : 'review  ', color: d.blocking ? 'error' : 'inactive' },
    { text: `${d.repo ? `${d.repo.split('/')[1]}${d.issue !== undefined ? `#${d.issue}` : ''} ` : ''}`, bold: true },
    { text: d.title },
    { text: ` · ${ago(d.createdAt, now)}`, dim: true },
  ];
}

const byRank = (a: WorkView, b: WorkView) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.order - b.order;

// the session's own work, or for a coordinator every session's, then the decisions that concern it
export function paneRows(f: Fleet, self: Self, room: number, web?: string): Row[] {
  const fleet = self.role === 'coordinator';
  const work = f.work.filter((w) => w.phase !== 'done' && (fleet || w.owner === self.session));
  const decisions = f.decisions.filter((d) => d.state === 'open' && (fleet || d.from?.session === self.session || work.some((w) => w.repo === d.repo && w.issue === d.issue)));
  const rows: Row[] = [summary(counts(work, decisions))];
  const wide = room > 12;
  if (fleet) {
    const live = f.sessions.filter((s) => !s.gone);
    for (const s of live) {
      const mine = work.filter((w) => w.owner === s.id).sort(byRank);
      if (s.id !== self.session && !mine.length && s.role !== 'repo') continue;
      rows.push([], [{ text: s.repo ?? s.title ?? s.id.slice(0, 8), bold: true }, { text: ` ${s.role}${s.id === self.session ? ' (this session)' : ''} · ${s.agents.filter((a) => a.status === 'running').length} agents running`, dim: true }]);
      for (const w of mine) rows.push(...workRows(w, wide));
    }
    const orphans = work.filter((w) => !live.some((s) => s.id === w.owner)).sort(byRank);
    if (orphans.length) {
      rows.push([], [{ text: 'no live session', color: 'warning', bold: true }]);
      for (const w of orphans) rows.push(...workRows(w, wide));
    }
  } else {
    if (!work.length) rows.push([{ text: 'nothing queued or active. dispatch an issue to start.', dim: true }]);
    for (const w of [...work].sort(byRank)) rows.push(...workRows(w, wide));
  }
  if (decisions.length) {
    rows.push([], [{ text: 'decisions', bold: true }]);
    for (const d of decisions.sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.createdAt - a.createdAt)) rows.push(decisionRow(d, f.at));
  }
  if (web) rows.push([], [{ text: web, dim: true }]);
  if (rows.length <= room) return rows;
  return [...rows.slice(0, room - 1), [{ text: `… ${rows.length - room + 1} more rows`, dim: true }]];
}

// one line above the prompt while something needs the person, nothing otherwise
export function bandRow(f: Fleet, self: Self): Row | undefined {
  const fleet = self.role === 'coordinator';
  const work = f.work.filter((w) => w.phase !== 'done' && (fleet || w.owner === self.session));
  const decisions = f.decisions.filter((d) => d.state === 'open' && (fleet || d.from?.session === self.session || work.some((w) => w.repo === d.repo && w.issue === d.issue)));
  const c = counts(work, decisions);
  if (!c.attention && !c.waiting) return undefined;
  return [{ text: 'helm ', color: 'claude', bold: true }, ...summary(c)];
}

export function statusText(f: Fleet, self: Self): string | undefined {
  const fleet = self.role === 'coordinator';
  const work = f.work.filter((w) => w.phase !== 'done' && (fleet || w.owner === self.session));
  if (!work.length && !f.decisions.some((d) => d.state === 'open' && d.blocking)) return undefined;
  const c = counts(work, f.decisions.filter((d) => fleet || d.from?.session === self.session || work.some((w) => w.repo === d.repo && w.issue === d.issue)));
  return [`helm ${c.active}▸`, c.ci ? `${c.ci}ci` : '', c.attention ? `${c.attention}!` : '', c.waiting ? `${c.waiting}?` : ''].filter(Boolean).join(' ');
}
