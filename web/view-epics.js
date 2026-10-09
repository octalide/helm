import { legend, meter, rollupBar, ROLLUP_LEGEND } from './charts.js';
import { el, empty, ext, fill, href, keyOf, phasePill, plural, repoShort, store, visibleTree } from './core.js';

// nodes the viewer folded, kept across redraws
const folded = new Set();

function find(tree, key) {
  const walk = (n, path) => {
    if (keyOf(n.repo, n.number) === key) return { node: n, path };
    for (const c of n.children) {
      const hit = walk(c, [...path, n]);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of tree) {
    const hit = walk(r, []);
    if (hit) return hit;
  }
  return null;
}

const isEpic = (n) => n.children.length > 0 || n.external;
const pct = (r) => (r.total ? Math.round((100 * r.done) / r.total) : 0);
const clean = (t) => t.replace(/^epic:\s*/i, '');

function nodeRow(n, depth, from) {
  const key = keyOf(n.repo, n.number);
  const epic = isEpic(n);
  const open = !folded.has(key);
  const name = n.repo === from ? `#${n.number}` : `${repoShort(n.repo)}#${n.number}`;
  const toggle = epic && n.children.length ? el('button', { type: 'button', class: `fold${open ? ' open' : ''}`, 'aria-label': open ? 'fold' : 'unfold', 'aria-expanded': String(open), onclick: (e) => (e.preventDefault(), open ? folded.add(key) : folded.delete(key), store.emit()) }, '▸') : el('span', { class: 'fold none' });
  const status = epic ? el('span', { class: 'pct' }, `${pct(n.rollup)}%`) : n.phase ? phasePill(n.phase) : el('span', { class: 'pill t-none' }, 'open');
  const progress = epic ? rollupBar(n.rollup, 'thin') : n.plan ? el('span', { class: 'plan-cell' }, meter(n.plan.done, n.plan.total, `plan ${n.plan.done} of ${n.plan.total}`), el('span', { class: 'dim' }, `${n.plan.done}/${n.plan.total}`)) : '';
  const who = [n.tier ? el('span', { class: 'chip tier' }, n.tier) : '', n.agent && n.phase !== 'done' ? el('span', { class: 'agent live', 'data-tip': `agent ${n.agent}` }, 'agent') : ''];
  const row = el(
    'div',
    { class: `trow${epic ? ' epic' : ''}${n.state === 'closed' ? ' closed' : ''}`, style: { '--depth': depth } },
    el('div', { class: 'tname' }, toggle, el('span', { class: 'ref' }, ext(n.url, name)), epic ? el('a', { class: 'ttitle', href: href('epics', key) }, clean(n.title)) : n.phase && n.phase !== 'done' ? el('a', { class: 'ttitle', href: href('epics', store.route.arg, { open: key }) }, n.title) : el('span', { class: 'ttitle' }, n.title), n.external ? el('span', { class: 'chip', 'data-tip': 'in a repository helm does not poll: counted from its summary' }, 'not watched') : ''),
    el('div', { class: 'tstatus' }, status),
    el('div', { class: 'tprog' }, progress),
    el('div', { class: 'tcount dim' }, epic ? `${n.rollup.done}/${n.rollup.total}` : ''),
    el('div', { class: 'twho' }, who),
  );
  const out = [row];
  if (open) for (const c of n.children) out.push(...nodeRow(c, depth + 1, n.repo));
  return out;
}

function header(n, path) {
  const r = n.rollup;
  const crumbs = el('nav', { class: 'crumbs' }, el('a', { href: href('epics') }, 'All epics'), path.map((p) => [el('span', { class: 'sep' }, '›'), el('a', { href: href('epics', keyOf(p.repo, p.number)) }, `${repoShort(p.repo)}#${p.number}`)]), el('span', { class: 'sep' }, '›'), el('span', {}, `${repoShort(n.repo)}#${n.number}`));
  const stat = (label, value, tone) => el('div', { class: `estat${tone ? ` k-${tone}` : ''}` }, el('b', {}, value), el('span', {}, label));
  return el(
    'section',
    { class: 'panel ehead' },
    crumbs,
    el('div', { class: 'ehead-main' }, el('div', { class: 'ehero' }, el('div', { class: 'ehero-num' }, `${pct(r)}%`), el('div', { class: 'dim' }, `${r.done} of ${plural(r.total, 'leaf', 'leaves')} done`)), el('div', { class: 'grow' }, el('h1', {}, ext(n.url, clean(n.title))), rollupBar(r, 'fat'), legend(ROLLUP_LEGEND))),
    el('div', { class: 'estats' }, stat('active', r.active), stat('in ci', r.ci), stat('ready', r.ready), stat('need attention', r.attention, r.attention ? 'bad' : ''), stat('queued', r.queued), stat('parked', r.parked || 0), stat('unowned', r.unowned)),
  );
}

function table(rows) {
  return el('div', { class: 'ttable' }, el('div', { class: 'trow thead' }, el('div', {}, 'issue'), el('div', {}, 'status'), el('div', {}, 'progress'), el('div', {}, 'leaves'), el('div', {}, 'on it')), rows);
}

export function epics(main) {
  const tree = visibleTree();
  const arg = store.route.arg;
  if (arg) {
    const hit = find(store.fleet.tree || [], arg);
    if (!hit) return fill(main, empty(`${arg} is in no epic helm sees.`, el('a', { href: href('epics') }, 'All epics')));
    const n = hit.node;
    const rows = n.children.flatMap((c) => nodeRow(c, 0, n.repo));
    return fill(main, header(n, hit.path), el('section', { class: 'panel' }, rows.length ? table(rows) : empty('No sub-issues read yet.')));
  }
  if (!tree.length) return fill(main, empty('No epics.', 'An open issue with sub-issues in a watched repository is an epic. Sub-issues in other repositories nest under it.'));
  const total = tree.reduce((a, t) => a + t.rollup.total, 0);
  const doneN = tree.reduce((a, t) => a + t.rollup.done, 0);
  const tools = el('div', { class: 'toolbar' }, el('span', { class: 'dim' }, `${plural(tree.length, 'epic')} · ${doneN}/${total} leaves done`), el('span', { class: 'grow' }), legend(ROLLUP_LEGEND), el('button', { type: 'button', class: 'chip-btn', onclick: () => (tree.forEach((t) => walkKeys(t, (k) => folded.add(k))), store.emit()) }, 'fold all'), el('button', { type: 'button', class: 'chip-btn', onclick: () => (folded.clear(), store.emit()) }, 'unfold all'));
  fill(main, tools, el('section', { class: 'panel' }, table(tree.flatMap((t) => nodeRow(t, 0, '')))));
}

function walkKeys(n, fn) {
  if (n.children.length) fn(keyOf(n.repo, n.number));
  for (const c of n.children) walkKeys(c, fn);
}
