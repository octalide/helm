import { stack } from './charts.js';
import { api, at, done, el, empty, ext, fill, filter, local, passing, plural, repoShort, setQuery, store } from './core.js';
import { ciBar, jobList, section, where } from './parts.js';

const KINDS = ['question', 'choice', 'routing', 'stall', 'failure'];

export function inbox(main, reload) {
  const kind = filter('kind');
  const all = store.fleet.decisions.filter((d) => d.state === 'open');
  const open = all.filter((d) => !kind || d.kind === kind).sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.createdAt - a.createdAt);
  // the cards keep their place across redraws, so an answer being written keeps its focus
  if (main.dataset.view !== 'inbox' || !main.querySelector('#cards')) {
    fill(main, el('div', { id: 'inbox-tools' }), el('div', { id: 'cards', class: 'cards' }), el('div', { id: 'inbox-settled' }));
    main.dataset.view = 'inbox';
  }
  main.querySelector('#inbox-tools').replaceChildren(
    el(
      'div',
      { class: 'toolbar' },
      el('div', { class: 'seg' }, el('button', { type: 'button', class: kind ? '' : 'on', onclick: () => setQuery({ kind: null }) }, `All ${all.length}`), KINDS.map((k) => el('button', { type: 'button', class: kind === k ? 'on' : '', onclick: () => setQuery({ kind: k }) }, `${k} ${all.filter((d) => d.kind === k).length}`))),
      el('span', { class: 'grow' }),
      el('span', { class: 'dim small' }, 'an answer resumes the agent waiting on it · ctrl+enter sends'),
    ),
  );
  const cards = main.querySelector('#cards');
  if (!open.length) cards.replaceChildren(empty(kind ? `No open ${kind} decisions.` : 'Nothing waits on you.', 'Questions agents are stopped on, choices they made without you, routing picks and stalls land here.'));
  else {
    if (cards.querySelector('.empty')) cards.replaceChildren();
    patchCards(cards, open, reload);
  }
  const settled = store.fleet.decisions.filter((d) => d.state !== 'open').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
  main.querySelector('#inbox-settled').replaceChildren(
    section(
      'Settled',
      el('span', { class: 'count' }, settled.length || ''),
      settled.length
        ? el('div', { class: 'list' }, settled.map((d) => el('div', { class: 'row' }, el('span', { class: 'chip kind' }, d.kind), el('span', { class: 'grow' }, where(d), ' ', d.title, d.answer ? el('span', { class: 'dim' }, ` → ${d.answer.option ? `${d.answer.option} ` : ''}${d.answer.text} (${d.answer.by})`) : ''), el('span', { class: 'dim' }, d.state, ' · ', at(d.updatedAt, ' ago')))))
        : empty('None yet.'),
    ),
  );
}

function patchCards(container, items, reload) {
  const old = new Map([...container.children].map((n) => [n.dataset.key, n]));
  container.replaceChildren(
    ...items.map((d) => {
      const sig = JSON.stringify([d.state, d.title, d.body, d.options, d.updatedAt]);
      const held = old.get(d.id);
      if (held && held.dataset.sig === sig) return held;
      const n = decisionCard(d, reload);
      n.dataset.key = d.id;
      n.dataset.sig = sig;
      return n;
    }),
  );
}

function decisionCard(d, reload) {
  const text = el('textarea', { placeholder: d.blocking ? 'Your answer, sent to the agent waiting on it' : 'Feedback, sent to whoever made the call (optional)', rows: 2 });
  const status = el('span', { class: 'meta' });
  const send = async (option) => {
    if (!option && !text.value.trim()) {
      status.textContent = 'write an answer or pick an option';
      return;
    }
    status.textContent = 'sending';
    try {
      const out = await api('POST', `/v1/decisions/${d.id}/answer`, { text: text.value.trim(), ...(option ? { option } : {}), by: 'human' });
      status.textContent = out.delivered ? 'delivered' : 'recorded; nobody live was waiting on it';
      reload();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const dismiss = async () => {
    try {
      await api('POST', `/v1/decisions/${d.id}/dismiss`);
      reload();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  return el(
    'article',
    { class: `card${d.blocking ? ' blocking' : ''}` },
    el('div', { class: 'head' }, el('span', { class: 'chip kind' }, d.kind), d.blocking ? el('span', { class: 'pill t-bad' }, 'waiting') : '', where(d), el('span', { class: 'grow' }), el('span', { class: 'meta' }, d.id, ' · ', at(d.createdAt, ' ago'))),
    el('div', { class: 'title' }, d.title),
    d.body ? el('div', { class: 'body' }, d.body) : '',
    d.from ? el('div', { class: 'meta' }, `from ${d.from.agent ? `agent ${d.from.agent.slice(0, 10)} in ` : ''}session ${d.from.session.slice(0, 8)}`) : '',
    el(
      'form',
      { onsubmit: (e) => (e.preventDefault(), send()), onkeydown: (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), send()) },
      text,
      el('div', { class: 'actions' }, d.kind === 'routing' && d.options ? el('span', { class: 'meta' }, 'reroute to') : '', (d.options || []).map((o) => el('button', { type: 'button', onclick: () => send(o) }, o)), el('span', { class: 'grow' }), status, el('button', { class: 'quiet', type: 'button', onclick: dismiss }, d.blocking ? 'Dismiss' : 'Reviewed'), el('button', { class: 'primary', type: 'submit' }, d.blocking ? 'Answer' : 'Send')),
    ),
  );
}

const REPO_VIEWS = ['prs', 'issues', 'runs', 'worktrees', 'branches'];

export function repos(main) {
  const f = store.fleet;
  const names = Object.keys(f.repos).sort();
  const repo = filter('repo') || (names.includes(local('repo')) ? local('repo') : names[0]);
  const view = REPO_VIEWS.includes(filter('tab')) ? filter('tab') : 'prs';
  if (!repo) return fill(main, empty('No repository is watched yet.'));
  local('repo', repo);
  const v = f.repos[repo];
  const forge = v && v.forge;
  const loc = v && v.local;
  const p = v ? v.polling : {};
  const counts = {
    prs: forge ? forge.pulls.filter((x) => x.state === 'open').length : 0,
    issues: forge ? forge.issues.filter((x) => x.state === 'open').length : 0,
    runs: forge ? forge.runs.filter((x) => !done(x.state)).length : 0,
    worktrees: loc ? loc.worktrees.length : 0,
    branches: loc ? loc.branches.length : 0,
  };
  const tabs = el(
    'div',
    { class: 'toolbar' },
    el('div', { class: 'seg' }, names.map((r) => el('button', { type: 'button', class: r === repo ? 'on' : '', onclick: () => setQuery({ repo: r }) }, repoShort(r)))),
    el('div', { class: 'seg' }, REPO_VIEWS.map((x) => el('button', { type: 'button', class: x === view ? 'on' : '', onclick: () => setQuery({ tab: x === 'prs' ? null : x }) }, `${x} ${counts[x]}`))),
    el('span', { class: 'grow' }),
    el('span', { class: 'dim small' }, p.lastPoll ? ['polled ', at(p.lastPoll, ' ago'), ` · every ${p.interval}s${p.active ? ', active' : ''}`] : 'not polled yet', p.error ? el('span', { class: 'status-bad' }, ` · ${p.error}`) : ''),
  );
  const link = (path, text) => ext(`https://github.com/${repo}/${path}`, text);
  let rows = [];
  if (view === 'issues')
    rows = (forge ? forge.issues.filter((i) => i.state === 'open') : []).map((i) =>
      el('div', { class: 'row' }, link(`issues/${i.number}`, `#${i.number}`), el('span', { class: 'grow' }, i.title, ' ', i.labels.map((x) => el('span', { class: 'chip' }, x)), i.subIssues ? el('span', { class: 'chip', 'data-tip': 'sub-issues done' }, `${i.subIssues.done}/${i.subIssues.total}`) : '', i.parent ? el('span', { class: 'dim small' }, ` in ${repoShort(i.parent.repo)}#${i.parent.number}`) : ''), el('span', { class: 'dim' }, i.comments ? `${plural(i.comments, 'comment')} · ` : '', at(Date.parse(i.updatedAt)))),
    );
  if (view === 'prs')
    rows = (forge ? forge.pulls.filter((x) => x.state === 'open') : []).map((x) => {
      const failed = x.checks.filter((c) => done(c.state) && !passing(c.state));
      return el('div', { class: 'row' }, link(`pull/${x.number}`, `#${x.number}`), el('span', { class: 'grow' }, x.draft ? el('span', { class: 'chip' }, 'draft') : '', ' ', x.title, el('div', { class: 'dim mono small' }, `${x.head} → ${x.base}${x.review ? ` · ${x.review.toLowerCase().replace(/_/g, ' ')}` : ''}`), ciBar(x.checks), failed.length ? el('div', { class: 'status-bad small' }, `failed: ${failed.map((c) => c.name).join(', ')}`) : ''), el('span', { class: 'dim' }, at(Date.parse(x.updatedAt))));
    });
  if (view === 'runs')
    rows = (forge ? forge.runs.slice(0, 30) : []).map((r) =>
      el('div', { class: 'row' }, el('span', { class: `rd o-${!done(r.state) ? 'run' : passing(r.state) ? 'ok' : 'bad'}` }, !done(r.state) ? '●' : passing(r.state) ? '✓' : '✗'), el('span', { class: 'grow' }, ext(r.url, r.workflow), ` ${r.tag ? 'tag ' : ''}${r.branch} `, el('span', { class: 'mono dim' }, `@${r.sha.slice(0, 7)} ${r.event}`), r.jobs && !done(r.state) ? jobList(repo, r.jobs) : ''), el('span', { class: 'dim' }, r.state, ' · ', at(Date.parse(r.updatedAt)))),
    );
  if (view === 'worktrees')
    rows = (loc ? loc.worktrees : []).map((w) => el('div', { class: 'row' }, el('span', { class: 'grow mono' }, w.path.replace(/^\/home\/[^/]+/, '~')), el('span', { class: 'mono' }, w.branch || `@${w.sha.slice(0, 7)}`), el('span', { class: w.dirty ? 'status-run' : 'dim' }, w.dirty ? `dirty ${w.dirty}` : 'clean'), el('span', { class: 'dim' }, w.ahead !== undefined ? `+${w.ahead}/-${w.behind}` : w.upstream ? '' : 'no upstream')));
  if (view === 'branches')
    rows = (loc ? loc.branches.slice(0, 80) : []).map((b) => el('div', { class: 'row' }, el('span', { class: 'grow mono' }, b.name), el('span', { class: b.gone ? 'status-bad' : 'dim' }, b.gone ? 'upstream gone' : b.upstream ? `${b.upstream}${b.ahead ? ` +${b.ahead}` : ''}${b.behind ? ` -${b.behind}` : ''}` : 'local only'), el('span', { class: 'dim' }, at(b.committedAt))));
  const rate = Object.entries(f.rates || {}).map(([pool, r]) => el('div', { class: 'rate' }, el('span', {}, pool), stack([{ value: r.remaining, tone: 'ready', label: `${pool} left this hour` }], r.limit, { size: 'thin', restLabel: 'used' }), el('span', { class: 'dim small' }, `${r.remaining}/${r.limit} · resets `, el('time', {}, new Date(r.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))));
  fill(main, tabs, section(`${repo} · ${view}`, el('span', { class: 'count' }, rows.length || ''), rows.length ? el('div', { class: 'list' }, rows) : empty(`No ${view}.`)), section('GitHub budget', el('span', { class: 'dim small' }, 'helmd is the only caller'), el('div', { class: 'rates' }, rate)));
}

const EVENT_KINDS = ['work', 'epic', 'decision', 'pr', 'issue', 'ci'];

export function activity(main) {
  const kind = filter('kind');
  const repo = filter('repo');
  const q = filter('q').toLowerCase();
  const events = [...(store.fleet.events || [])].reverse().filter((e) => (!kind || e.kind === kind) && (!repo || e.repo === repo) && (!q || `${e.text} ${(e.detail || []).join(' ')}`.toLowerCase().includes(q)));
  const tools = el('div', { class: 'toolbar' }, el('div', { class: 'seg' }, el('button', { type: 'button', class: kind ? '' : 'on', onclick: () => setQuery({ kind: null }) }, 'All'), EVENT_KINDS.map((k) => el('button', { type: 'button', class: kind === k ? 'on' : '', onclick: () => setQuery({ kind: k }) }, k))), el('span', { class: 'grow' }), el('span', { class: 'dim small' }, `${plural(events.length, 'event')}`));
  const days = new Map();
  for (const e of events.slice(0, 300)) {
    const d = new Date(e.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(e);
  }
  fill(main, 
    tools,
    events.length
      ? [...days].map(([d, list]) =>
          section(
            d,
            el('span', { class: 'count' }, list.length),
            el(
              'div',
              { class: 'feed' },
              list.map((e) => el('div', { class: `ev k-${e.kind}` }, el('span', { class: 'ev-time' }, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), el('span', { class: `ev-kind` }, e.kind), el('div', { class: 'grow' }, e.repo ? el('b', {}, `${repoShort(e.repo)} `) : '', e.url ? ext(e.url, e.text) : e.text, (e.detail || []).length ? el('div', { class: 'dim small' }, e.detail.slice(0, 4).map((x) => el('div', {}, x))) : ''))),
            ),
          ),
        )
      : empty('Nothing yet.'),
  );
}
