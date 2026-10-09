// the detail of one work item, opened over any view by the open= query
import { segmentsOf } from './charts.js';
import { $, at, dur, el, ext, filter, isRecord, issueUrl, keyOf, model, PHASE, phasePill, phaseSince, planOf, repoShort, setQuery, store } from './core.js';
import { agentDot, checkText, ciBar, jobList, tierChip } from './parts.js';

export function renderDrawer() {
  const key = filter('open');
  const box = $('drawer');
  if (!key || !store.fleet) {
    box.hidden = true;
    document.body.classList.remove('drawn');
    return;
  }
  const w = store.fleet.work.find((x) => keyOf(x.repo, x.issue) === key);
  box.hidden = false;
  document.body.classList.add('drawn');
  const close = el('button', { type: 'button', class: 'quiet', 'aria-label': 'close', onclick: () => setQuery({ open: null }) }, '✕');
  if (!w) return box.replaceChildren(el('header', { class: 'dh' }, el('b', {}, key), close), el('div', { class: 'empty' }, 'Not in the ledger: nobody has claimed or queued it.'));

  const plan = planOf(w);
  const segs = segmentsOf(w);
  const total = segs.reduce((a, s) => a + (s.to - s.from), 0) || 1;
  const decisions = store.fleet.decisions.filter((d) => d.repo === w.repo && d.issue === w.issue).sort((a, b) => b.createdAt - a.createdAt);
  const owner = store.fleet.sessions.find((s) => s.id === w.owner);
  const root = store.roots.get(key);

  box.replaceChildren(
    el('header', { class: 'dh' }, el('span', { class: 'ref' }, ext(w.issueUrl || issueUrl(w.repo, w.issue), `${repoShort(w.repo)}#${w.issue}`)), phasePill(w.phase), el('span', { class: 'grow' }), close),
    el('h2', { class: 'dtitle' }, w.title),
    el(
      'div',
      { class: 'dmeta' },
      agentDot(w),
      tierChip(w),
      w.pull ? ext(w.pull.url, el('span', { class: 'chip' }, `pr #${w.pull.number}${w.pull.draft ? ' draft' : ''}`)) : '',
      owner ? el('span', { class: 'chip' }, `session ${owner.repo ? repoShort(owner.repo) : owner.id.slice(0, 8)}${owner.gone ? ' (gone)' : ''}`) : '',
      root && root !== key ? el('a', { class: 'chip', href: `#/epics/${encodeURIComponent(root)}` }, `epic ${root.split('/')[1]}`) : '',
    ),
    w.report && w.report.note ? el('div', { class: 'dnote' }, el('b', {}, w.report.state), ' ', w.report.note, el('span', { class: 'dim' }, ' · ', at(w.report.at, ' ago'))) : '',
    el(
      'section',
      { class: 'dsec' },
      el('h3', {}, 'Phases', el('small', {}, `in ${PHASE[w.phase].label} for `, at(phaseSince(w)))),
      el('div', { class: 'stack fat' }, segs.map((s) => el('i', { class: `t-${PHASE[s.phase].tone}${s.phase === 'queued' ? ' hatch' : ''}`, style: { flexGrow: String(Math.max(1, s.to - s.from)) }, 'data-tip': `${PHASE[s.phase].label}\n${dur(s.to - s.from)}${s.open ? ' so far' : ''}` }))),
      el('ol', { class: 'steps' }, segs.map((s) => el('li', {}, el('span', { class: `dot t-${PHASE[s.phase].tone}` }), el('span', { class: 'grow' }, PHASE[s.phase].label), el('span', { class: 'dim' }, new Date(s.from).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })), el('b', {}, `${dur(s.to - s.from)}${s.open ? '…' : ''}`), el('span', { class: 'dim pct' }, `${Math.round((100 * (s.to - s.from)) / total)}%`)))),
    ),
    plan.total
      ? el('section', { class: 'dsec' }, el('h3', {}, 'Plan', el('small', {}, `${plan.done} of ${plan.total}`)), el('ul', { class: 'plan' }, w.plan.map((s) => el('li', { class: s.done ? 'done' : s === plan.next ? 'next' : '' }, el('span', { class: 'box', 'aria-hidden': 'true' }, s.done ? '✓' : ''), s.text))))
      : '',
    w.checks.length || w.jobs.length
      ? el('section', { class: 'dsec' }, el('h3', {}, 'CI', el('small', {}, checkText(w.checks))), ciBar(w.checks), jobList(w.repo, w.jobs, true), el('ul', { class: 'checks' }, w.checks.map((c) => el('li', { class: c.state }, el('span', { class: 'dot' }), c.url ? ext(c.url, c.name) : c.name, el('span', { class: 'dim' }, c.state)))))
      : '',
    w.routing
      ? el('section', { class: 'dsec' }, el('h3', {}, 'Routing'), el('div', {}, el('b', {}, w.routing.tier || 'named'), ` · ${model(w.routing.model)} / ${w.routing.effort} · by ${w.routing.by}${w.routing.confidence !== undefined ? ` at ${Math.round(w.routing.confidence * 100)}%` : ''}`), w.routing.reason ? el('div', { class: 'dim' }, w.routing.reason) : '')
      : '',
    decisions.length
      ? el('section', { class: 'dsec' }, el('h3', {}, 'Decisions'), el('div', { class: 'list' }, decisions.map((d) => el('div', { class: 'row' }, el('span', { class: 'chip kind' }, d.kind), el('span', { class: 'grow' }, d.title, d.answer ? el('div', { class: 'dim' }, `→ ${d.answer.option ? `${d.answer.option} ` : ''}${d.answer.text}`) : ''), el('a', { class: 'dim', href: isRecord(d) ? '#/review' : '#/inbox' }, isRecord(d) && d.state === 'dismissed' ? 'reviewed' : d.state)))))
      : '',
    w.leftovers?.length
      ? el('section', { class: 'dsec' }, el('h3', {}, 'Left running', el('small', {}, 'when its agent ended; helm kills nothing')), el('ul', { class: 'checks' }, w.leftovers.map((p) => el('li', { class: 'running' }, el('span', { class: 'dot' }), el('span', { class: 'mono small' }, `pid ${p.pid}`), el('span', { class: 'mono small grow' }, p.command)))))
      : '',
    w.worktree
      ? el('section', { class: 'dsec' }, el('h3', {}, 'Worktree'), el('div', { class: 'mono small' }, w.worktree.path.replace(/^\/home\/[^/]+/, '~')), el('div', { class: 'dim small' }, `${w.worktree.branch || ''}${w.worktree.dirty ? ` · ${w.worktree.dirty} dirty` : ' · clean'}${w.worktree.ahead !== undefined ? ` · +${w.worktree.ahead}/-${w.worktree.behind}` : ''}`))
      : '',
    el('div', { class: 'dfoot dim small' }, 'queued ', at(w.queuedAt, ' ago'), w.claimedAt ? [' · claimed ', at(w.claimedAt, ' ago')] : '', ' · updated ', at(w.updatedAt, ' ago'), w.finished ? ` · ${w.finished.how}` : ''),
  );
}
