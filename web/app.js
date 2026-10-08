'use strict';

const $ = (id) => document.getElementById(id);
const ui = { repo: localGet('repo'), view: localGet('view') || 'prs', fleet: null };
const RANK = { blocked: 0, failing: 1, stalled: 2, ci: 3, ready: 4, draft: 5, working: 6, queued: 7, done: 8 };

function localGet(k) {
  try {
    return localStorage.getItem(`helm.${k}`);
  } catch {
    return null;
  }
}

function localSet(k, v) {
  try {
    localStorage.setItem(`helm.${k}`, v);
  } catch {}
}

// a dom node from a tag, its attributes (on* are listeners) and children
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k !== undefined && k !== null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const done = (s) => s !== 'queued' && s !== 'running';
const passing = (s) => s === 'success' || s === 'skipped' || s === 'neutral';
const short = (m) => (m || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
const repoShort = (r) => (r || '').split('/')[1] || r;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `http ${res.status}`);
  return data;
}

let loading = false;
let again = false;

async function load() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    ui.fleet = await api('GET', '/v1/fleet');
    render();
  } catch (e) {
    setConn(false, e.message);
  } finally {
    loading = false;
    if (again) {
      again = false;
      setTimeout(load, 300);
    }
  }
}

function setConn(live, why) {
  const c = $('conn');
  c.className = `conn ${live ? 'live' : 'down'}`;
  c.textContent = live ? `helmd ${ui.fleet ? ui.fleet.version : ''}` : `disconnected${why ? `: ${why}` : ''}`;
}

function connect() {
  const es = new EventSource('/v1/events');
  let timer;
  es.addEventListener('open', () => {
    setConn(true);
    load();
  });
  es.addEventListener('changed', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 400);
  });
  es.addEventListener('error', () => setConn(false));
  // relative times move on their own
  setInterval(() => ui.fleet && renderTimes(), 15000);
}

function render() {
  const f = ui.fleet;
  setConn(true);
  renderSummary(f);
  renderInbox(f);
  renderWork(f);
  renderRepos(f);
  renderEvents(f);
  renderSessions(f);
}

function renderTimes() {
  for (const n of document.querySelectorAll('[data-at]')) n.textContent = ago(Number(n.dataset.at));
}

const at = (ms, suffix = '') => el('span', { 'data-at': ms, title: new Date(ms).toLocaleString() }, ago(ms) + suffix);

function renderSummary(f) {
  const open = f.work.filter((w) => w.phase !== 'done');
  const waiting = f.decisions.filter((d) => d.state === 'open' && d.blocking).length;
  const review = f.decisions.filter((d) => d.state === 'open' && !d.blocking).length;
  const attention = open.filter((w) => ['blocked', 'failing', 'stalled'].includes(w.phase)).length;
  const live = f.sessions.filter((s) => !s.gone).length;
  const core = f.rates.core;
  const gql = f.rates.graphql;
  const item = (n, label, bad) => el('span', { class: bad && n ? 'bad' : '' }, el('b', {}, n), ` ${label}`);
  $('summary').replaceChildren(
    item(open.filter((w) => w.phase !== 'queued').length, 'active'),
    item(open.filter((w) => w.phase === 'queued').length, 'queued'),
    item(attention, 'need attention', true),
    item(waiting, 'waiting on you', true),
    item(review, 'for review'),
    item(live, `session${live === 1 ? '' : 's'}`),
    core ? el('span', { title: 'REST calls left this hour' }, `rest ${core.remaining}/${core.limit}`) : '',
    gql ? el('span', { title: 'GraphQL points left this hour' }, `graphql ${gql.remaining}/${gql.limit}`) : '',
  );
  document.title = waiting ? `(${waiting}) helm` : 'helm';
}

// keyed children: a node whose signature is unchanged is kept as it is, so a half-written answer survives a redraw
function patch(container, items, key, sig, draw) {
  const old = new Map([...container.children].map((n) => [n.dataset.key, n]));
  const next = items.map((it) => {
    const k = key(it);
    const s = sig(it);
    const held = old.get(k);
    if (held && held.dataset.sig === s) return held;
    const n = draw(it);
    n.dataset.key = k;
    n.dataset.sig = s;
    return n;
  });
  container.replaceChildren(...next);
}

function where(d) {
  if (!d.repo) return '';
  const url = d.issue !== undefined ? `https://github.com/${d.repo}/issues/${d.issue}` : `https://github.com/${d.repo}`;
  return el('a', { href: url, target: '_blank', rel: 'noopener' }, `${repoShort(d.repo)}${d.issue !== undefined ? `#${d.issue}` : ''}`);
}

function renderInbox(f) {
  const open = f.decisions.filter((d) => d.state === 'open').sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.createdAt - a.createdAt);
  $('inbox-count').textContent = open.length ? `${open.length}` : '';
  if (!open.length) $('inbox').replaceChildren(el('div', { class: 'empty' }, 'Nothing waits on you.'));
  else {
    if ($('inbox').querySelector('.empty')) $('inbox').replaceChildren();
    patch($('inbox'), open, (d) => d.id, (d) => JSON.stringify([d.state, d.title, d.body, d.options, d.updatedAt]), decisionCard);
  }
  const settled = f.decisions.filter((d) => d.state !== 'open').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
  $('settled').replaceChildren(
    ...(settled.length
      ? settled.map((d) =>
          el('div', { class: 'row' }, el('span', { class: 'chip kind' }, d.kind), el('span', { class: 'grow' }, where(d), ' ', d.title, d.answer ? el('span', { class: 'dim' }, ` → ${d.answer.option ? `${d.answer.option} ` : ''}${d.answer.text} (${d.answer.by})`) : ''), el('span', { class: 'dim' }, d.state, ' ', at(d.updatedAt, ' ago'))),
        )
      : [el('div', { class: 'empty' }, 'None yet.')]),
  );
}

function decisionCard(d) {
  const text = el('textarea', { placeholder: d.blocking ? 'Your answer, sent to the agent waiting on it' : 'Feedback, sent to whoever made the call (optional)' });
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
      load();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const dismiss = async () => {
    try {
      await api('POST', `/v1/decisions/${d.id}/dismiss`);
      load();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const options = (d.options || []).map((o) => el('button', { type: 'button', onclick: () => send(o) }, o));
  return el(
    'article',
    { class: `card${d.blocking ? ' blocking' : ''}` },
    el('div', { class: 'head' }, el('span', { class: 'chip kind' }, d.kind), d.blocking ? el('span', { class: 'chip', style: 'color:var(--bad)' }, 'waiting') : '', where(d), el('span', { class: 'meta' }, d.id, ' · ', at(d.createdAt, ' ago'))),
    el('div', { class: 'title' }, d.title),
    d.body ? el('div', { class: 'body' }, d.body) : '',
    el(
      'form',
      { onsubmit: (e) => (e.preventDefault(), send()) },
      text,
      el('div', { class: 'actions' }, d.kind === 'routing' ? el('span', { class: 'meta' }, 'reroute to') : '', ...options, el('button', { class: 'primary', type: 'submit' }, d.blocking ? 'Answer' : 'Send'), el('button', { class: 'quiet', type: 'button', onclick: dismiss }, d.blocking ? 'Dismiss' : 'Reviewed'), status),
    ),
  );
}

function ciBar(checks) {
  if (!checks.length) return '';
  const pct = (n) => `${(100 * n) / checks.length}%`;
  const ok = checks.filter((c) => done(c.state) && passing(c.state)).length;
  const bad = checks.filter((c) => done(c.state) && !passing(c.state)).length;
  const run = checks.filter((c) => c.state === 'running').length;
  return el('div', { class: 'bar', title: `${ok} passed, ${bad} failed, ${run} running, ${checks.length - ok - bad - run} queued` }, el('i', { class: 'ok', style: `width:${pct(ok)}` }), el('i', { class: 'bad', style: `width:${pct(bad)}` }), el('i', { class: 'run', style: `width:${pct(run)}` }));
}

function jobList(repo, jobs) {
  const shown = jobs.filter((j) => !done(j.state) || !passing(j.state));
  if (!shown.length) return '';
  return el(
    'ul',
    { class: 'jobs' },
    shown.slice(0, 12).map((j) => {
      const on = j.steps.find((s) => s.state === 'running');
      const count = j.steps.filter((s) => done(s.state)).length;
      return el(
        'li',
        { class: done(j.state) ? 'failure' : j.state },
        el('a', { href: j.url, target: '_blank', rel: 'noopener' }, j.name),
        el('span', { class: 'step' }, done(j.state) ? j.state : j.steps.length ? `step ${count + (on ? 1 : 0)}/${j.steps.length}${on ? ` ${on.name}` : ''}` : j.state),
        done(j.state) ? el('button', { type: 'button', onclick: () => showLog(repo, j) }, 'log') : '',
      );
    }),
  );
}

function workItem(w) {
  const issue = w.issueUrl || `https://github.com/${w.repo}/issues/${w.issue}`;
  const sub = [
    w.agent ? el('span', { title: `agent ${w.agent}` }, `agent ${w.agentStatus || '?'}`) : el('span', {}, 'no agent'),
    w.routing ? el('span', { title: w.routing.reason || '' }, `${w.routing.tier ? `${w.routing.tier} · ` : ''}${short(w.routing.model)}/${w.routing.effort}`) : '',
    w.pull ? el('a', { href: w.pull.url, target: '_blank', rel: 'noopener' }, `pr #${w.pull.number}${w.pull.draft ? ' draft' : ''}`) : '',
    w.worktree ? el('span', { class: 'mono', title: w.worktree.path }, `${w.worktree.branch || ''}${w.worktree.dirty ? ` · dirty ${w.worktree.dirty}` : ''}`) : '',
    w.decisions ? el('span', { style: 'color:var(--bad)' }, `${w.decisions} decision${w.decisions === 1 ? '' : 's'}`) : '',
  ];
  return el(
    'div',
    { class: 'item' },
    el('span', { class: `phase ${w.phase}` }, w.phase),
    el('div', { class: 'main' }, el('div', { class: 'name' }, el('a', { href: issue, target: '_blank', rel: 'noopener' }, `${repoShort(w.repo)}#${w.issue}`), ' ', w.title), el('div', { class: 'sub' }, sub), w.report && w.report.note ? el('div', { class: 'note' }, `${w.report.state}: ${w.report.note}`) : '', ciBar(w.checks), jobList(w.repo, w.jobs)),
    el('div', { class: 'side' }, at(w.updatedAt, ' ago')),
  );
}

function renderWork(f) {
  const open = f.work.filter((w) => w.phase !== 'done');
  $('work-count').textContent = open.length ? `${open.length}` : '';
  const sessions = new Map(f.sessions.map((s) => [s.id, s]));
  const groups = new Map();
  for (const w of open) {
    const k = w.owner && sessions.get(w.owner) && !sessions.get(w.owner).gone ? w.owner : '';
    groups.set(k, [...(groups.get(k) || []), w]);
  }
  const out = [];
  for (const [owner, items] of [...groups].sort(([a], [b]) => (a === '') - (b === ''))) {
    const s = sessions.get(owner);
    items.sort((a, b) => RANK[a.phase] - RANK[b.phase] || a.order - b.order);
    out.push(el('div', { class: 'session' }, el('div', { class: 'label' }, el('b', {}, s ? s.repo || s.title || owner.slice(0, 8) : 'no live session'), s ? el('span', {}, `${s.role} · ${owner.slice(0, 8)}`) : ''), items.map(workItem)));
  }
  const recent = f.work.filter((w) => w.phase === 'done').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  if (recent.length) out.push(el('details', { class: 'history' }, el('summary', {}, `Recently done (${recent.length})`), recent.map(workItem)));
  $('work').replaceChildren(...(out.length ? out : [el('div', { class: 'empty' }, 'No work queued or active.')]));
}

const VIEWS = ['prs', 'issues', 'runs', 'worktrees', 'branches'];

function renderRepos(f) {
  const repos = Object.keys(f.repos).sort();
  if (!ui.repo || !repos.includes(ui.repo)) ui.repo = repos[0] || null;
  $('repo-tabs').replaceChildren(...repos.map((r) => el('button', { type: 'button', class: r === ui.repo ? 'on' : '', onclick: () => ((ui.repo = r), localSet('repo', r), renderRepos(ui.fleet)) }, repoShort(r))));
  $('repo-views').replaceChildren(...VIEWS.map((v) => el('button', { type: 'button', class: v === ui.view ? 'on' : '', onclick: () => ((ui.view = v), localSet('view', v), renderRepos(ui.fleet)) }, v)));
  const view = ui.repo ? f.repos[ui.repo] : null;
  if (!view) return $('repo').replaceChildren(el('div', { class: 'empty' }, 'No repository is watched yet.'));
  const p = view.polling;
  const foot = el('div', { class: 'row' }, el('span', { class: 'dim' }, p.lastPoll ? ['polled ', at(p.lastPoll, ' ago'), ` · every ${p.interval}s${p.active ? ' (active)' : ''}`] : 'not polled yet', p.error ? el('span', { class: 'status-bad' }, ` · ${p.error}`) : ''));
  const rows = repoRows(ui.repo, view);
  $('repo').replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty' }, `No ${ui.view}.`)]), foot);
}

function stateClass(s) {
  return !done(s) ? 'status-run' : passing(s) ? 'status-ok' : 'status-bad';
}

function repoRows(repo, view) {
  const f = view.forge;
  const l = view.local;
  const link = (path, text) => el('a', { href: `https://github.com/${repo}/${path}`, target: '_blank', rel: 'noopener' }, text);
  switch (ui.view) {
    case 'issues':
      return (f ? f.issues.filter((i) => i.state === 'open') : []).map((i) => el('div', { class: 'row' }, link(`issues/${i.number}`, `#${i.number}`), el('span', { class: 'grow' }, i.title, ' ', i.labels.map((x) => el('span', { class: 'chip' }, x))), el('span', { class: 'dim' }, i.comments ? `${i.comments} ✎ · ` : '', at(Date.parse(i.updatedAt), ''))));
    case 'prs':
      return (f ? f.pulls.filter((x) => x.state === 'open') : []).map((x) => {
        const failed = x.checks.filter((c) => done(c.state) && !passing(c.state));
        return el('div', { class: 'row' }, link(`pull/${x.number}`, `#${x.number}`), el('span', { class: 'grow' }, x.draft ? el('span', { class: 'chip' }, 'draft') : '', ' ', x.title, el('div', { class: 'dim mono' }, `${x.head} → ${x.base}`), ciBar(x.checks), failed.length ? el('div', { class: 'status-bad', style: 'font-size:12px' }, `failed: ${failed.map((c) => c.name).join(', ')}`) : ''), el('span', { class: 'dim' }, at(Date.parse(x.updatedAt), '')));
      });
    case 'runs':
      return (f ? f.runs.slice(0, 25) : []).map((r) => el('div', { class: 'row' }, el('span', { class: stateClass(r.state) }, '●'), el('span', { class: 'grow' }, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.workflow), ` ${r.tag ? 'tag ' : ''}${r.branch} `, el('span', { class: 'mono dim' }, `@${r.sha.slice(0, 7)} ${r.event}`), r.jobs && !done(r.state) ? jobList(repo, r.jobs) : ''), el('span', { class: 'dim' }, r.state, ' · ', at(Date.parse(r.updatedAt), ''))));
    case 'worktrees':
      return (l ? l.worktrees : []).map((w) => el('div', { class: 'row' }, el('span', { class: 'grow mono' }, w.path), el('span', { class: 'mono' }, w.branch || `@${w.sha.slice(0, 7)}`), el('span', { class: 'dim' }, w.dirty ? `dirty ${w.dirty}` : 'clean', w.ahead !== undefined ? ` · +${w.ahead}/-${w.behind}` : '')));
    case 'branches':
      return (l ? l.branches.slice(0, 50) : []).map((b) => el('div', { class: 'row' }, el('span', { class: 'grow mono' }, b.name), el('span', { class: 'dim' }, b.gone ? 'upstream gone' : b.upstream ? `${b.upstream}${b.ahead ? ` +${b.ahead}` : ''}${b.behind ? ` -${b.behind}` : ''}` : 'local only', ' · ', at(b.committedAt, ''))));
  }
  return [];
}

function renderEvents(f) {
  const events = [...(f.events || [])].reverse().slice(0, 60);
  $('events').replaceChildren(...(events.length ? events.map((e) => el('div', { class: 'row' }, el('span', { class: 'dim' }, at(e.at, '')), el('span', { class: 'grow' }, e.repo ? el('b', {}, `${repoShort(e.repo)} `) : '', e.url ? el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.text) : e.text))) : [el('div', { class: 'empty' }, 'Nothing yet.')]));
}

function renderSessions(f) {
  const live = f.sessions.filter((s) => !s.gone);
  $('sessions').replaceChildren(
    ...(live.length
      ? live.map((s) => {
          const running = s.agents.filter((a) => ['running', 'pending', 'waiting'].includes(a.status));
          return el('div', { class: 'row' }, el('span', { class: 'chip kind' }, s.role), el('span', { class: 'grow' }, el('b', {}, s.repo || s.title || ''), el('span', { class: 'dim mono' }, ` ${s.id.slice(0, 8)}`), running.length ? el('div', { class: 'dim' }, running.map((a) => a.description || a.type).join(' · ')) : ''), el('span', { class: 'dim' }, `${running.length}/${s.agents.length} agents · `, at(s.seenAt, ' ago')));
        })
      : [el('div', { class: 'empty' }, 'No live sessions.')]),
  );
}

async function showLog(repo, job) {
  $('log-title').textContent = `${job.name} · job ${job.id}`;
  $('log-body').textContent = 'loading';
  $('log').showModal();
  try {
    const res = await fetch(`/v1/repos/${repo}/jobs/${job.id}/log?errors=1&tail=400`);
    $('log-body').textContent = await res.text();
  } catch (e) {
    $('log-body').textContent = e.message;
  }
}

connect();
