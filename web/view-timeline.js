import { gantt, legend, segmentsOf } from './charts.js';
import { dur, el, empty, fill, filter, href, keyOf, PHASE, PHASES, repoShort, setQuery, visibleWork } from './core.js';

const RANGES = { '6h': 6 * 3600_000, '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function timeline(main) {
  const range = RANGES[filter('range')] ? filter('range') : '24h';
  const to = Date.now();
  const from = to - RANGES[range];
  const rows = visibleWork()
    .map((w) => ({ w, segs: segmentsOf(w, to).filter((s) => s.to > from) }))
    .filter((r) => r.segs.length)
    .sort((a, b) => (a.w.phase === 'done') - (b.w.phase === 'done') || a.segs[0].from - b.segs[0].from);

  const tools = el(
    'div',
    { class: 'toolbar' },
    el('div', { class: 'seg' }, Object.keys(RANGES).map((r) => el('button', { type: 'button', class: r === range ? 'on' : '', onclick: () => setQuery({ range: r === '24h' ? null : r }) }, r))),
    el('span', { class: 'grow' }),
    legend(
      PHASES.filter((p) => p !== 'done' && p !== 'draft' && p !== 'blocked')
        .map((p) => [PHASE[p].tone, p === 'working' ? 'working, draft' : p === 'failing' ? 'failing, blocked' : PHASE[p].label]),
    ),
  );
  if (!rows.length) return fill(main, tools, empty(`Nothing moved in the last ${range}.`, 'Each work item draws a lane of the phases it went through.'));

  const labels = el(
    'div',
    { class: 'tl-labels' },
    el('div', { class: 'tl-head' }),
    rows.map(({ w }) => el('a', { class: 'tl-label', href: href('timeline', '', { open: keyOf(w.repo, w.issue) }), 'data-tip': `${w.repo}#${w.issue}\n${w.title}` }, el('span', { class: 'ref' }, `${repoShort(w.repo)}#${w.issue}`), el('span', { class: 'ttl' }, w.title))),
  );
  const chart = gantt(
    rows.map(({ w, segs }) => ({ label: `#${w.issue}`, segments: segs })),
    from,
    to,
    { label: `phases of each work item over the last ${range}` },
  );

  // how long work sat in each phase, over the stretches inside the window that have ended
  const spans = {};
  for (const { segs } of rows) for (const s of segs) if (!s.open) (spans[s.phase] ||= []).push(s.to - s.from);
  const phases = PHASES.filter((p) => spans[p] && p !== 'done');
  const longest = Math.max(1, ...phases.map((p) => median(spans[p])));
  const dwell = el(
    'section',
    { class: 'panel' },
    el('header', { class: 'ph' }, el('h2', {}, 'Time in phase'), el('span', { class: 'dim small' }, `median of finished stretches, last ${range}`)),
    phases.length
      ? el(
          'div',
          { class: 'hbars' },
          phases.map((p) => {
            const m = median(spans[p]);
            return el('div', { class: 'hbar' }, el('span', { class: 'hbar-label' }, PHASE[p].label), el('span', { class: 'hbar-track' }, el('i', { class: `t-${PHASE[p].tone}`, style: { width: `${(100 * m) / longest}%` }, 'data-tip': `${PHASE[p].label}\nmedian ${dur(m)} over ${spans[p].length} stretches\nlongest ${dur(Math.max(...spans[p]))}` })), el('b', {}, dur(m)));
          }),
        )
      : empty('No finished stretch in this window yet.'),
  );

  fill(main, tools, el('section', { class: 'panel tl' }, labels, el('div', { class: 'tl-chart' }, chart)), dwell);
}
