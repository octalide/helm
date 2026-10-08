import { el, empty, filter, keyOf, RANK, repoShort, sessionName, setQuery, store, visibleWork } from './core.js';
import { workCard } from './parts.js';

// the board's columns, left to right; attention gathers the three phases that need someone
const COLUMNS = [
  { id: 'queued', label: 'Queued', phases: ['queued'], tone: 'queued' },
  { id: 'working', label: 'Working', phases: ['working'], tone: 'work' },
  { id: 'draft', label: 'Draft PR', phases: ['draft'], tone: 'work' },
  { id: 'ci', label: 'In CI', phases: ['ci'], tone: 'ci' },
  { id: 'ready', label: 'Ready', phases: ['ready'], tone: 'ready' },
  { id: 'attention', label: 'Attention', phases: ['blocked', 'failing', 'stalled'], tone: 'bad' },
  { id: 'done', label: 'Done', phases: ['done'], tone: 'done' },
];

const GROUPS = { none: 'No lanes', session: 'By session', epic: 'By epic', repo: 'By repository', tier: 'By tier' };
const DONE_MS = 3 * 86400_000;

function laneOf(w, group) {
  if (group === 'session') {
    const s = store.fleet.sessions.find((x) => x.id === w.owner);
    return { key: w.owner || '', label: s && !s.gone ? sessionName(s) : 'no live session' };
  }
  if (group === 'epic') {
    const root = store.roots.get(keyOf(w.repo, w.issue));
    const node = root && (store.fleet.tree || []).find((t) => keyOf(t.repo, t.number) === root);
    return { key: root || '', label: node ? `${repoShort(node.repo)}#${node.number} ${node.title.replace(/^epic:\s*/i, '')}` : 'in no epic' };
  }
  if (group === 'repo') return { key: w.repo, label: w.repo };
  if (group === 'tier') return { key: (w.routing && w.routing.tier) || '', label: (w.routing && w.routing.tier) || 'unrouted' };
  return { key: '', label: '' };
}

export function board(main) {
  const group = filter('group') || 'none';
  const only = filter('phase');
  const now = Date.now();
  const work = visibleWork().filter((w) => w.phase !== 'done' || (w.finished && now - w.finished.at < DONE_MS) || (!w.finished && now - w.updatedAt < DONE_MS));
  const cols = only ? COLUMNS.filter((c) => c.phases.includes(only) || c.id === only) : COLUMNS;

  const controls = el(
    'div',
    { class: 'toolbar' },
    el('div', { class: 'seg' }, Object.entries(GROUPS).map(([id, label]) => el('button', { type: 'button', class: id === group ? 'on' : '', onclick: () => setQuery({ group: id === 'none' ? null : id }) }, label))),
    only ? el('button', { type: 'button', class: 'chip-btn', onclick: () => setQuery({ phase: null }) }, `phase: ${only} ✕`) : '',
    el('span', { class: 'grow' }),
    el('span', { class: 'dim small' }, `${work.filter((w) => w.phase !== 'done').length} open · done shows the last 3 days`),
  );

  const lanes = new Map();
  for (const w of work) {
    const l = laneOf(w, group);
    if (!lanes.has(l.key)) lanes.set(l.key, { ...l, items: [] });
    lanes.get(l.key).items.push(w);
  }
  const ordered = [...lanes.values()].sort((a, b) => (a.key === '') - (b.key === '') || a.label.localeCompare(b.label));

  const grid = el('div', { class: 'board', style: { gridTemplateColumns: `repeat(${cols.length}, minmax(176px, 1fr))` } });
  for (const c of cols) {
    const n = work.filter((w) => c.phases.includes(w.phase)).length;
    grid.append(el('div', { class: `bcol-head t-line-${c.tone}` }, el('span', {}, c.label), el('b', {}, n)));
  }
  for (const lane of ordered) {
    if (group !== 'none') grid.append(el('div', { class: 'lane-head', style: { gridColumn: `1 / span ${cols.length}` } }, el('b', {}, lane.label), el('span', { class: 'dim' }, ` ${lane.items.filter((w) => w.phase !== 'done').length} open`)));
    for (const c of cols) {
      const items = lane.items.filter((w) => c.phases.includes(w.phase)).sort((a, b) => RANK[a.phase] - RANK[b.phase] || a.order - b.order);
      grid.append(el('div', { class: 'bcol' }, items.map((w) => workCard(w, { view: 'board', pill: c.phases.length > 1 }))));
    }
  }
  main.replaceChildren(controls, work.length ? el('div', { class: 'board-wrap' }, grid) : empty('No work matches.', 'Repository sessions queue issues with backlog and start them with dispatch.'));
}

