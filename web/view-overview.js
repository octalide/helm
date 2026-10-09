import { columns, legend, rollupBar, ROLLUP_LEGEND, spark, stack } from './charts.js';
import { at, ATTENTION, done, el, empty, ext, fill, href, keyOf, PHASE, phasePill, PHASES, phaseSince, plural, repoShort, store, visibleTree, visibleWork } from './core.js';
import { section, where } from './parts.js';

const DAY = 86400_000;

// finished work per day, oldest first, for the last n days
export function finishedPerDay(work, days, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * DAY;
  const out = Array.from({ length: days }, (_, i) => ({ at: first + i * DAY, value: 0, items: [] }));
  for (const w of work) {
    if (!w.finished || w.finished.how === 'abandoned') continue;
    const i = Math.floor((w.finished.at - first) / DAY);
    if (i >= 0 && i < days) {
      out[i].value++;
      out[i].items.push(w);
    }
  }
  return out;
}

function tile(label, value, opts = {}) {
  return el(
    opts.href ? 'a' : 'div',
    { class: `tile${opts.tone ? ` k-${opts.tone}` : ''}${opts.hero ? ' hero' : ''}`, ...(opts.href ? { href: opts.href } : {}), ...(opts.tip ? { 'data-tip': opts.tip } : {}) },
    el('div', { class: 'tile-label' }, opts.icon ? el('span', { class: `ico ${opts.icon}`, 'aria-hidden': 'true' }) : '', label),
    el('div', { class: 'tile-value' }, String(value)),
    opts.sub ? el('div', { class: 'tile-sub' }, opts.sub) : '',
    opts.spark || '',
  );
}

export function overview(main) {
  const f = store.fleet;
  const work = visibleWork(f);
  const open = work.filter((w) => w.phase !== 'done');
  const by = (p) => open.filter((w) => w.phase === p);
  const active = open.filter((w) => PHASE[w.phase].group === 'active');
  const attention = open.filter((w) => ATTENTION.has(w.phase));
  const decisions = f.decisions.filter((d) => d.state === 'open');
  const waiting = decisions.filter((d) => d.blocking);
  const agents = f.sessions.filter((s) => !s.gone).flatMap((s) => s.agents.filter((a) => ['running', 'pending', 'waiting'].includes(a.status)));
  const per = finishedPerDay(work, 14);
  const week = per.slice(-7).reduce((a, d) => a + d.value, 0);
  const runs = Object.entries(f.repos).flatMap(([repo, v]) => (v.forge ? v.forge.runs.filter((r) => !done(r.state)).map((r) => ({ repo, r })) : []));

  const tiles = el(
    'div',
    { class: 'tiles' },
    tile('Active work', active.length, { hero: true, href: href('board'), sub: `${plural(agents.length, 'agent')} running across ${plural(f.sessions.filter((s) => !s.gone).length, 'session')}` }),
    tile('Waiting on you', waiting.length, { tone: waiting.length ? 'bad' : '', icon: 'i-ask', href: href('inbox'), sub: `${decisions.length - waiting.length} more for review` }),
    tile('Needs attention', attention.length, { tone: attention.length ? 'bad' : '', icon: 'i-alert', href: href('board'), sub: ['blocked', 'failing', 'stalled'].map((p) => `${by(p).length} ${p}`).join(' · ') }),
    tile('In CI', by('ci').length, { icon: 'i-ci', href: href('ci'), sub: `${plural(runs.length, 'run')} in flight` }),
    tile('Ready to merge', by('ready').length, { icon: 'i-ok', href: href('board'), sub: by('ready').map((w) => `#${w.issue}`).join(' ') || 'none' }),
    tile('Done this week', week, { icon: 'i-done', sub: `${per[per.length - 1].value} today`, spark: spark(per.map((d) => d.value)), tip: 'work merged or closed, per day over 14 days' }),
  );

  fill(main, 
    tiles,
    el('div', { class: 'grid two' }, attentionPanel(attention, waiting, by('ready')), liveCi(runs, open)),
    el('div', { class: 'grid two' }, epicsPanel(), el('div', { class: 'col' }, pipelinePanel(open), throughputPanel(per))),
    sessionsStrip(open),
  );
}

function attentionPanel(attention, waiting, ready) {
  const rows = [
    ...waiting.map((d) => ({ rank: 0, at: d.createdAt, node: el('a', { class: 'arow', href: href('inbox', '', { open: null }) }, el('span', { class: 'pill t-bad' }, 'question'), el('span', { class: 'grow' }, where(d), ' ', d.title), at(d.createdAt)) })),
    ...attention.map((w) => ({ rank: 1, at: phaseSince(w), node: el('a', { class: 'arow', href: href('board', '', { open: keyOf(w.repo, w.issue) }) }, phasePill(w.phase), el('span', { class: 'grow' }, el('b', {}, `${repoShort(w.repo)}#${w.issue}`), ' ', w.title, w.report && w.report.note ? el('div', { class: 'dim' }, w.report.note) : ''), at(phaseSince(w))) })),
    ...ready.map((w) => ({ rank: 2, at: phaseSince(w), node: el('a', { class: 'arow', href: href('board', '', { open: keyOf(w.repo, w.issue) }) }, phasePill('ready'), el('span', { class: 'grow' }, el('b', {}, `${repoShort(w.repo)}#${w.issue}`), ' ', w.title, w.pull ? el('span', { class: 'dim' }, ` · pr #${w.pull.number}`) : ''), at(phaseSince(w))) })),
  ].sort((a, b) => a.rank - b.rank || a.at - b.at);
  return section('Attention', el('span', { class: 'count' }, rows.length || ''), rows.length ? el('div', { class: 'alist' }, rows.map((r) => r.node)) : empty('Nothing needs you.', 'Questions, blocked or failing work and PRs ready to merge show here.'));
}

function liveCi(runs, open) {
  const byPull = new Map();
  for (const w of open) if (w.pull) byPull.set(`${w.repo}:${w.pull.head}`, w);
  const rows = runs
    .sort((a, b) => Date.parse(b.r.updatedAt) - Date.parse(a.r.updatedAt))
    .slice(0, 8)
    .map(({ repo, r }) => {
      const jobs = r.jobs || [];
      const fin = jobs.filter((j) => done(j.state)).length;
      const steps = jobs.flatMap((j) => j.steps);
      const stepsDone = steps.filter((s) => done(s.state)).length;
      const w = byPull.get(`${repo}:${r.branch}`);
      const on = jobs.flatMap((j) => j.steps.filter((s) => s.state === 'running').map((s) => `${j.name}: ${s.name}`));
      return el(
        'div',
        { class: 'cirow' },
        el('div', { class: 'cihead' }, el('span', { class: 'pulse', 'aria-hidden': 'true' }), ext(r.url, el('b', {}, r.workflow)), el('span', { class: 'dim' }, ` ${repoShort(repo)} · ${r.tag ? 'tag ' : ''}${r.branch}`), w ? el('a', { class: 'chip', href: href('board', '', { open: keyOf(w.repo, w.issue) }) }, `#${w.issue}`) : '', el('span', { class: 'grow' }), at(Date.parse(r.createdAt))),
        stack(
          [
            { value: jobs.filter((j) => done(j.state) && j.state === 'success').length, tone: 'done', label: 'jobs passed' },
            { value: jobs.filter((j) => done(j.state) && j.state !== 'success').length, tone: 'bad', label: 'jobs failed' },
            { value: jobs.filter((j) => j.state === 'running').length, tone: 'ci', label: 'jobs running' },
          ],
          jobs.length || 1,
          { size: 'thin', restLabel: 'jobs queued' },
        ),
        el('div', { class: 'dim small' }, jobs.length ? `${fin}/${jobs.length} jobs · ${stepsDone}/${steps.length} steps` : 'jobs not read yet', on.length ? ` · ${on[0]}` : ''),
      );
    });
  return section('CI in flight', el('a', { class: 'more', href: href('ci') }, 'all runs →'), rows.length ? rows : empty('No run in flight.', 'Runs show here with their jobs and steps while they run.'));
}

function epicsPanel() {
  const tree = visibleTree().filter((t) => t.state === 'open');
  const rows = tree
    .slice()
    .sort((a, b) => b.rollup.active + b.rollup.attention - (a.rollup.active + a.rollup.attention) || a.rollup.done / (a.rollup.total || 1) - b.rollup.done / (b.rollup.total || 1))
    .map((t) => {
      const r = t.rollup;
      const pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
      return el(
        'a',
        { class: 'erow', href: href('epics', keyOf(t.repo, t.number)) },
        el('div', { class: 'erow-head' }, el('span', { class: 'ref' }, `${repoShort(t.repo)}#${t.number}`), el('span', { class: 'grow etitle' }, t.title.replace(/^epic:\s*/i, '')), el('b', { class: 'pct' }, `${pct}%`)),
        rollupBar(r),
        el('div', { class: 'dim small' }, `${r.done}/${r.total} done`, r.active ? ` · ${r.active} active` : '', r.attention ? ` · ${r.attention} need attention` : '', r.unowned ? ` · ${r.unowned} unowned` : ''),
      );
    });
  return section('Epics', el('a', { class: 'more', href: href('epics') }, 'tree →'), rows.length ? [legend(ROLLUP_LEGEND), el('div', { class: 'elist' }, rows)] : empty('No epics.', 'An open issue with sub-issues in a watched repository is an epic.'));
}

function pipelinePanel(open) {
  const counts = PHASES.filter((p) => p !== 'done').map((p) => ({ p, n: open.filter((w) => w.phase === p).length }));
  const segs = counts.map(({ p, n }) => ({ value: n, tone: PHASE[p].tone, label: PHASE[p].label, hatch: p === 'queued' }));
  return section(
    'Pipeline',
    el('span', { class: 'count' }, open.length || ''),
    stack(segs, undefined, { size: 'fat' }),
    el(
      'div',
      { class: 'pipe' },
      counts.map(({ p, n }) => el('a', { class: `pipe-step${n ? '' : ' zero'}`, href: href('board', '', { phase: p }) }, el('i', { class: `t-${PHASE[p].tone}${p === 'queued' ? ' hatch' : ''}` }), el('span', {}, PHASE[p].label), el('b', {}, n))),
    ),
  );
}

function throughputPanel(per) {
  const fmt = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const points = per.map((d) => ({ label: fmt(d.at), value: d.value, tip: `${fmt(d.at)}\n${plural(d.value, 'item')} finished${d.items.length ? `\n${d.items.slice(0, 6).map((w) => `#${w.issue} ${w.title}`).join('\n')}` : ''}` }));
  return section('Throughput', el('span', { class: 'dim small' }, 'merged or closed per day, 14 days'), columns(points, { tone: 'done', height: 120, label: 'work finished per day' }));
}

function sessionsStrip(open) {
  const live = store.fleet.sessions.filter((s) => !s.gone);
  if (!live.length) return '';
  return section(
    'Sessions',
    el('a', { class: 'more', href: href('agents') }, 'agents →'),
    el(
      'div',
      { class: 'strip' },
      live.map((s) => {
        const mine = open.filter((w) => w.owner === s.id);
        const running = s.agents.filter((a) => ['running', 'pending', 'waiting'].includes(a.status));
        return el(
          'a',
          { class: 'scard', href: href('board', '', { session: s.id }) },
          el('div', { class: 'scard-head' }, el('span', { class: `chip role-${s.role}` }, s.role), el('b', {}, s.repo ? repoShort(s.repo) : s.title || s.id.slice(0, 8))),
          stack(
            PHASES.filter((p) => p !== 'done').map((p) => ({ value: mine.filter((w) => w.phase === p).length, tone: PHASE[p].tone, label: PHASE[p].label, hatch: p === 'queued' })),
            undefined,
            { size: 'thin' },
          ),
          el('div', { class: 'dim small' }, `${plural(mine.length, 'item')} · ${plural(running.length, 'agent')} live · seen `, at(s.seenAt, ' ago')),
          running.length ? el('div', { class: 'agents-mini' }, running.slice(0, 4).map((a) => el('span', { class: 'agent live', 'data-tip': `${a.type}\n${a.description}` }, a.name || a.description.slice(0, 28)))) : '',
        );
      }),
    ),
  );
}

