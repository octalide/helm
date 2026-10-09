import { isDone, isPassing } from '../core/checks.ts';
import { percent } from '../core/tree.ts';
import type { Decision, Fleet, Job, Phase, Rollup, Run, SessionRole, TreeNode, WorkView } from '../core/types.ts';
import { selfWorked } from '../core/work.ts';
import { ago } from './format.ts';

// what a surface draws: rows of styled segments, so the drawing is plain data the hooks module maps onto elements.
// a segment with press is a control: its press is the address the hooks module routes, its hotkey one key
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean; press?: string; hotkey?: string; boxed?: boolean };
export type Row = Seg[];

export type Self = { session: string; role: SessionRole; repo?: string };

export type Tab = 'work' | 'epics' | 'ci' | 'inbox';
export const TABS: readonly { id: Tab; label: string; hotkey: string }[] = [
  { id: 'work', label: 'Work', hotkey: '1' },
  { id: 'epics', label: 'Epics', hotkey: '2' },
  { id: 'ci', label: 'CI', hotkey: '3' },
  { id: 'inbox', label: 'Inbox', hotkey: '4' },
];
export const isTab = (t: unknown): t is Tab => TABS.some((x) => x.id === t);

export type PaneOpts = { rows: number; cols: number; tab: Tab; web?: string };

const PHASE_COLOR: Record<Phase, string> = {
  queued: 'inactive',
  working: 'claude',
  draft: 'claude',
  ci: 'warning',
  failing: 'error',
  ready: 'suggestion',
  blocked: 'error',
  stalled: 'warning',
  parked: 'planMode',
  done: 'success',
};

const PHASE_GLYPH: Record<Phase, string> = { queued: '○', working: '●', draft: '◐', ci: '◔', ready: '◆', failing: '✗', blocked: '■', stalled: '◌', parked: '‖', done: '✓' };

// the order work is listed in: what needs someone first, then what moves, then what waits
const PHASE_RANK: Record<Phase, number> = { blocked: 0, failing: 1, stalled: 2, ready: 3, ci: 4, draft: 5, working: 6, queued: 7, parked: 8, done: 9 };
const byRank = (a: WorkView, b: WorkView) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.order - b.order;

const short = (model: string) => model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
const repoShort = (r: string) => r.split('/')[1] ?? r;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function counts(work: readonly WorkView[], decisions: readonly Decision[]) {
  const open = work.filter((w) => w.phase !== 'done');
  return {
    active: open.filter((w) => w.phase !== 'queued' && w.phase !== 'parked').length,
    queued: open.filter((w) => w.phase === 'queued').length,
    parked: open.filter((w) => w.phase === 'parked').length,
    ci: open.filter((w) => w.phase === 'ci').length,
    attention: open.filter((w) => w.phase === 'blocked' || w.phase === 'failing' || w.phase === 'stalled').length,
    waiting: decisions.filter((d) => d.state === 'open' && d.blocking).length,
    review: decisions.filter((d) => d.state === 'open' && !d.blocking).length,
  };
}

function summary(c: ReturnType<typeof counts>): Row {
  const row: Row = [{ text: `${c.active} active`, bold: true }];
  if (c.queued) row.push({ text: ` · ${c.queued} queued`, dim: true });
  if (c.parked) row.push({ text: ` · ${c.parked} parked`, dim: true });
  if (c.ci) row.push({ text: ` · ${c.ci} in ci`, color: 'warning' });
  if (c.attention) row.push({ text: ` · ${c.attention} need attention`, color: 'error' });
  if (c.waiting) row.push({ text: ` · ${c.waiting} waiting on a decision`, color: 'error', bold: true });
  if (c.review) row.push({ text: ` · ${c.review} for review`, dim: true });
  return row;
}

// what this session sees: its own work and the decisions about it, or for a coordinator everything
function scope(f: Fleet, self: Self) {
  const fleet = self.role === 'coordinator';
  const work = f.work.filter((w) => w.phase !== 'done' && (fleet || w.owner === self.session));
  const decisions = f.decisions.filter((d) => d.state === 'open' && (fleet || d.from?.session === self.session || work.some((w) => w.repo === d.repo && w.issue === d.issue)));
  const repos = fleet ? Object.keys(f.repos) : [...new Set([...(self.repo ? [self.repo] : []), ...work.map((w) => w.repo)])];
  return { fleet, work, decisions, repos };
}

// a bar of parts over a total, `width` cells: each part with any count gets at least one cell, the rest is track
export function bar(parts: readonly { n: number; color: string }[], total: number, width: number): Seg[] {
  if (total <= 0 || width <= 0) return [{ text: '─'.repeat(Math.max(0, width)), dim: true }];
  const shown = parts.filter((p) => p.n > 0);
  const exact = shown.map((p) => (p.n / total) * width);
  const cells = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = Math.round((shown.reduce((a, p) => a + p.n, 0) / total) * width) - cells.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0 && k < order.length; k++, left--) cells[order[k]!.i]!++;
  while (cells.reduce((a, b) => a + b, 0) > width) {
    const i = cells.indexOf(Math.max(...cells));
    cells[i]!--;
  }
  const out: Seg[] = shown.map((p, i) => ({ text: '━'.repeat(cells[i]!), color: p.color }));
  const used = cells.reduce((a, b) => a + b, 0);
  if (used < width) out.push({ text: '─'.repeat(width - used), dim: true });
  return out;
}

export function meter(done: number, total: number, width: number, color = 'success'): Seg[] {
  const on = total ? Math.round((done / total) * width) : 0;
  return [
    { text: '▰'.repeat(on), color },
    { text: '▱'.repeat(width - on), dim: true },
  ];
}

export function rollupParts(r: Rollup): { n: number; color: string }[] {
  return [
    { n: r.done, color: 'success' },
    { n: r.ready, color: 'suggestion' },
    { n: r.ci, color: 'warning' },
    { n: Math.max(0, r.active - r.ci - r.ready), color: 'claude' },
    { n: r.attention, color: 'error' },
    { n: r.queued, color: 'inactive' },
    { n: r.parked, color: PHASE_COLOR.parked },
  ];
}

function tabRow(f: Fleet, self: Self, tab: Tab): Row {
  const s = scope(f, self);
  const runs = s.repos.flatMap((r) => f.repos[r]?.runs ?? []);
  const badge: Record<Tab, string> = {
    work: s.work.length ? ` ${s.work.length}` : '',
    epics: '',
    ci: runs.some((r) => !isDone(r.state)) ? ` ${runs.filter((r) => !isDone(r.state)).length}` : '',
    inbox: s.decisions.length ? ` ${s.decisions.length}` : '',
  };
  const row: Row = [];
  for (const t of TABS) {
    if (row.length) row.push({ text: '  ' });
    row.push({ text: `${t.label}${badge[t.id]}`, press: `tab:${t.id}`, hotkey: t.hotkey, bold: t.id === tab, ...(t.id === tab ? { color: 'claude' } : t.id === 'inbox' && s.decisions.some((d) => d.blocking) ? { color: 'error' } : {}) });
  }
  return row;
}

function workRows(w: WorkView, o: { cols: number; fleet: boolean; now: number }): Row[] {
  const wide = o.cols >= 56;
  const head: Row = [
    { text: `${PHASE_GLYPH[w.phase]} `, color: PHASE_COLOR[w.phase] },
    { text: `${w.phase.padEnd(8)}`, color: PHASE_COLOR[w.phase], bold: w.phase === 'blocked' || w.phase === 'failing' },
    { text: `${o.fleet ? repoShort(w.repo) : ''}#${w.issue} `, bold: true },
    { text: w.title },
  ];
  const at = w.history?.at(-1)?.at ?? w.updatedAt;
  if (wide) head.push({ text: ` · ${ago(at, o.now)}`, dim: true });
  const rows: Row[] = [head];
  const pad = { text: '  ' };
  const steps = w.plan ?? [];
  if (steps.length) {
    const done = steps.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done);
    rows.push([pad, ...meter(done, steps.length, clamp(steps.length, 4, 10)), { text: ` ${done}/${steps.length}`, dim: true }, ...(next ? [{ text: ` next: ${next.text}` }] : [])]);
  } else if (w.report?.note) rows.push([pad, { text: w.report.note, dim: true }]);
  if (w.checks.length) {
    const ok = w.checks.filter((c) => isDone(c.state) && isPassing(c.state)).length;
    const bad = w.checks.filter((c) => isDone(c.state) && !isPassing(c.state));
    const run = w.checks.filter((c) => c.state === 'running').length;
    const row: Row = [pad, { text: 'ci ', dim: true }, ...bar([{ n: ok, color: 'success' }, { n: bad.length, color: 'error' }, { n: run, color: 'warning' }], w.checks.length, 8), { text: ` ${ok}/${w.checks.length}`, dim: true }];
    if (bad.length) row.push({ text: ` ✗ ${bad.map((c) => c.name).join(', ')}`, color: 'error' });
    else {
      const live = runningStep(w.jobs);
      if (live) row.push({ text: ` ▸ ${live}`, dim: true });
    }
    rows.push(row);
  }
  if (wide) {
    const meta = [w.agent ? `agent ${w.agentStatus ?? '?'}` : selfWorked(w) ? 'its session' : 'no agent', w.routing ? `${w.routing.tier ?? ''} ${short(w.routing.model)}/${w.routing.effort}`.trim() : '', w.pull ? `pr #${w.pull.number}${w.pull.draft ? ' draft' : ''}` : '', w.decisions ? `${w.decisions} decision${w.decisions === 1 ? '' : 's'}` : ''].filter(Boolean);
    rows.push([pad, { text: meta.join(' · '), dim: true }]);
  }
  return rows;
}

function runningStep(jobs: readonly Job[]): string | undefined {
  for (const j of jobs) {
    if (isDone(j.state)) continue;
    const on = j.steps.find((s) => s.state === 'running');
    const n = j.steps.filter((s) => isDone(s.state)).length;
    return `${j.name}${j.steps.length ? ` ${n + (on ? 1 : 0)}/${j.steps.length}` : ''}${on ? ` ${on.name}` : ''}`;
  }
  return undefined;
}

function workTab(f: Fleet, self: Self, o: PaneOpts): Row[] {
  const s = scope(f, self);
  const rows: Row[] = [summary(counts(s.work, s.decisions))];
  const width = clamp(o.cols - 4, 12, 48);
  if (s.work.length) {
    const phases: Phase[] = ['ready', 'ci', 'working', 'draft', 'failing', 'blocked', 'stalled', 'queued', 'parked'];
    rows.push(bar(phases.map((p) => ({ n: s.work.filter((w) => w.phase === p).length, color: PHASE_COLOR[p] })), s.work.length, width));
  }
  const fmt = { cols: o.cols, fleet: s.fleet, now: f.at };
  if (s.fleet) {
    const live = f.sessions.filter((x) => !x.gone);
    for (const x of live) {
      const mine = s.work.filter((w) => w.owner === x.id).sort(byRank);
      if (!mine.length) continue;
      rows.push([], [{ text: x.repo ? repoShort(x.repo) : (x.title ?? x.id.slice(0, 8)), bold: true }, { text: ` ${x.role}${x.id === self.session ? ' (this session)' : ''} · ${x.agents.filter((a) => a.status === 'running').length} agents running`, dim: true }]);
      for (const w of mine) rows.push(...workRows(w, fmt));
    }
    const orphans = s.work.filter((w) => !live.some((x) => x.id === w.owner)).sort(byRank);
    if (orphans.length) {
      rows.push([], [{ text: 'no live session', color: 'warning', bold: true }]);
      for (const w of orphans) rows.push(...workRows(w, fmt));
    }
  } else {
    if (!s.work.length) rows.push([], [{ text: 'nothing queued or active. queue issues with backlog, start them with dispatch.', dim: true }]);
    for (const w of [...s.work].sort(byRank)) rows.push([], ...workRows(w, fmt));
  }
  return rows;
}

// the subtree's leaves that someone is on, what moves under an epic
function moving(n: TreeNode): TreeNode[] {
  if (!n.children.length) return n.phase && n.phase !== 'done' && n.phase !== 'parked' ? [n] : [];
  return n.children.flatMap(moving);
}

function epicsTab(f: Fleet, self: Self, o: PaneOpts): Row[] {
  const s = scope(f, self);
  const touches = (n: TreeNode): boolean => s.repos.includes(n.repo) || n.children.some(touches);
  const roots = f.tree.filter((t) => t.state === 'open' && (s.fleet || touches(t)));
  if (!roots.length) return [[{ text: 'no epics here. an open issue with sub-issues is one.', dim: true }]];
  const width = clamp(o.cols - 12, 10, 40);
  const rows: Row[] = [];
  const sorted = [...roots].sort((a, b) => b.rollup.active + b.rollup.attention - (a.rollup.active + a.rollup.attention) || percent(a.rollup) - percent(b.rollup));
  for (const t of sorted) {
    const r = t.rollup;
    if (rows.length) rows.push([]);
    rows.push([{ text: `${String(percent(r)).padStart(3)}% `, bold: true }, { text: `${repoShort(t.repo)}#${t.number} `, dim: true }, { text: t.title.replace(/^epic:\s*/i, ''), bold: true }]);
    rows.push([{ text: '     ' }, ...bar(rollupParts(r), r.total, width), { text: ` ${r.done}/${r.total}`, dim: true }]);
    const notes = [r.active ? `${r.active} active` : '', r.ci ? `${r.ci} in ci` : '', r.ready ? `${r.ready} ready` : '', r.queued ? `${r.queued} queued` : '', r.parked ? `${r.parked} parked` : '', r.unowned ? `${r.unowned} unowned` : ''].filter(Boolean);
    if (r.attention) rows.push([{ text: '     ' }, { text: `${r.attention} need attention`, color: 'error' }, ...(notes.length ? [{ text: ` · ${notes.join(' · ')}`, dim: true }] : [])]);
    else if (notes.length) rows.push([{ text: '     ' }, { text: notes.join(' · '), dim: true }]);
    for (const n of moving(t).sort((a, b) => PHASE_RANK[a.phase!] - PHASE_RANK[b.phase!]).slice(0, 4)) {
      rows.push([{ text: '     ' }, { text: `${PHASE_GLYPH[n.phase!]} `, color: PHASE_COLOR[n.phase!] }, { text: `${n.repo === t.repo ? '' : repoShort(n.repo)}#${n.number} `, bold: true }, { text: n.title }, ...(n.plan ? [{ text: ` ${n.plan.done}/${n.plan.total}`, dim: true }] : [])]);
    }
  }
  return rows;
}

function runRows(repo: string, r: Run, o: { cols: number; now: number; many: boolean }): Row[] {
  const live = !isDone(r.state);
  const glyph = live ? '◔' : isPassing(r.state) ? '✓' : '✗';
  const color = live ? 'warning' : isPassing(r.state) ? 'success' : 'error';
  const head: Row = [{ text: `${glyph} `, color }, { text: r.workflow, bold: true }, { text: ` ${o.many ? `${repoShort(repo)} ` : ''}${r.tag ? 'tag ' : ''}${r.branch} · ${live ? 'started' : r.state} ${ago(Date.parse(live ? r.createdAt : r.updatedAt), o.now)} ago`, dim: true }];
  const rows: Row[] = [head];
  const jobs = r.jobs ?? [];
  if (!jobs.length) return rows;
  const ok = jobs.filter((j) => isDone(j.state) && isPassing(j.state)).length;
  const bad = jobs.filter((j) => isDone(j.state) && !isPassing(j.state));
  const run = jobs.filter((j) => j.state === 'running');
  if (live) rows.push([{ text: '  ' }, ...bar([{ n: ok, color: 'success' }, { n: bad.length, color: 'error' }, { n: run.length, color: 'warning' }], jobs.length, clamp(o.cols - 18, 8, 32)), { text: ` ${ok + bad.length}/${jobs.length} jobs`, dim: true }]);
  for (const j of run.slice(0, 3)) {
    const on = j.steps.find((s) => s.state === 'running');
    const n = j.steps.filter((s) => isDone(s.state)).length;
    rows.push([{ text: '  ▸ ', color: 'warning' }, { text: j.name }, ...(j.steps.length ? [{ text: ` ${n + (on ? 1 : 0)}/${j.steps.length}`, dim: true }] : []), ...(on ? [{ text: ` ${on.name}`, dim: true }] : [])]);
  }
  for (const j of bad.slice(0, 3)) rows.push([{ text: '  ✗ ', color: 'error' }, { text: j.name }, { text: ` job ${j.id}`, dim: true }]);
  return rows;
}

function ciTab(f: Fleet, self: Self, o: PaneOpts): Row[] {
  const s = scope(f, self);
  const runs = s.repos.flatMap((repo) => (f.repos[repo]?.runs ?? []).map((r) => ({ repo, r }))).sort((a, b) => Number(isDone(a.r.state)) - Number(isDone(b.r.state)) || Date.parse(b.r.createdAt) - Date.parse(a.r.createdAt));
  if (!runs.length) return [[{ text: 'no run in flight or finished in the last half hour.', dim: true }]];
  const live = runs.filter((x) => !isDone(x.r.state)).length;
  const failed = runs.filter((x) => isDone(x.r.state) && !isPassing(x.r.state)).length;
  const rows: Row[] = [[{ text: `${live} in flight`, bold: true }, ...(failed ? [{ text: ` · ${failed} failed`, color: 'error' }] : []), { text: ` · ${runs.length - live - failed} passed lately`, dim: true }]];
  const fmt = { cols: o.cols, now: f.at, many: s.repos.length > 1 };
  for (const { repo, r } of runs) rows.push([], ...runRows(repo, r, fmt));
  return rows;
}

function inboxTab(f: Fleet, self: Self, o: PaneOpts): Row[] {
  const s = scope(f, self);
  if (!s.decisions.length) return [[{ text: 'nothing waits on you.', dim: true }]];
  const rows: Row[] = [];
  const sorted = [...s.decisions].sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.createdAt - a.createdAt);
  for (const d of sorted) {
    if (rows.length) rows.push([]);
    rows.push([{ text: `${d.blocking ? 'waiting' : d.kind}`.padEnd(9), color: d.blocking ? 'error' : 'inactive', bold: d.blocking }, { text: d.repo ? `${repoShort(d.repo)}${d.issue !== undefined ? `#${d.issue}` : ''} ` : '', bold: true }, { text: d.title }, { text: ` · ${ago(d.createdAt, f.at)}`, dim: true }]);
    const first = d.body.split('\n').find((l) => l.trim());
    if (first) rows.push([{ text: '         ' }, { text: first, dim: true }]);
    const controls: Row = [{ text: '         ' }];
    for (const [i, option] of (d.options ?? []).entries()) controls.push({ text: option, press: `answer:${d.id}:${i}`, boxed: true }, { text: ' ' });
    controls.push({ text: d.blocking ? 'dismiss' : 'reviewed', press: `dismiss:${d.id}`, dim: true });
    rows.push(controls);
  }
  if (o.web) rows.push([], [{ text: `a written answer: ${o.web}`, dim: true }]);
  return rows;
}

const TAB_ROWS: Record<Tab, (f: Fleet, self: Self, o: PaneOpts) => Row[]> = { work: workTab, epics: epicsTab, ci: ciTab, inbox: inboxTab };

// the pane: the tab row, then the tab's rows cut to the room there is
export function paneRows(f: Fleet, self: Self, o: PaneOpts): Row[] {
  const body = TAB_ROWS[o.tab](f, self, o);
  const room = Math.max(2, o.rows - 2);
  const cut = body.length <= room ? body : [...body.slice(0, room - 1), [{ text: `… ${body.length - room + 1} more rows`, dim: true }]];
  return [tabRow(f, self, o.tab), [], ...cut];
}

// one line above the prompt while something needs the person, nothing otherwise
export function bandRow(f: Fleet, self: Self): Row | undefined {
  const s = scope(f, self);
  const c = counts(s.work, s.decisions);
  if (!c.attention && !c.waiting) return undefined;
  return [{ text: 'helm ', color: 'claude', bold: true }, ...summary(c)];
}

export function statusText(f: Fleet, self: Self): string | undefined {
  const s = scope(f, self);
  if (!s.work.length && !f.decisions.some((d) => d.state === 'open' && d.blocking)) return undefined;
  const c = counts(s.work, s.decisions);
  return [`helm ${c.active}▸`, c.ci ? `${c.ci}ci` : '', c.attention ? `${c.attention}!` : '', c.waiting ? `${c.waiting}?` : ''].filter(Boolean).join(' ');
}
