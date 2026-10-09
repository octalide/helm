// shared state, dom helpers and formatting for every view

export const $ = (id) => document.getElementById(id);

// a dom node from a tag, its attributes (on* are listeners) and children. an svg tag is made in the svg namespace
const SVG = new Set(['svg', 'g', 'rect', 'line', 'path', 'circle', 'text', 'title', 'polyline', 'defs', 'pattern', 'clipPath', 'tspan']);
export function el(tag, attrs, ...kids) {
  const n = SVG.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k !== undefined && k !== null && k !== false && k !== '') n.append(k instanceof Node ? k : String(k));
  return n;
}

// a container's children replaced, flattened and with empty values skipped as el does
export function fill(container, ...kids) {
  container.replaceChildren(...kids.flat(Infinity).filter((k) => k !== undefined && k !== null && k !== false && k !== ''));
}

// keyed children: a node whose signature is unchanged is kept, so focus and a half-written answer survive a redraw
export function patch(container, items, key, sig, draw) {
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

export function local(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(`helm.${k}`);
    if (v === null) localStorage.removeItem(`helm.${k}`);
    else localStorage.setItem(`helm.${k}`, v);
  } catch {}
  return null;
}

export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data && data.error) || `http ${res.status}`);
  return data;
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return dur(s * 1000);
}

export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m && h < 10 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h && d < 10 ? `${d}d ${h}h` : `${d}d`;
}

// a relative time that the clock keeps current
export const at = (ms, suffix = '') => el('time', { 'data-at': ms, 'data-suffix': suffix, title: new Date(ms).toLocaleString() }, ago(ms) + suffix);
export function tickTimes() {
  for (const n of document.querySelectorAll('[data-at]')) n.textContent = ago(Number(n.dataset.at)) + (n.dataset.suffix || '');
}

export const done = (s) => s !== 'queued' && s !== 'running';
export const passing = (s) => s === 'success' || s === 'skipped' || s === 'neutral';
export const model = (m) => (m || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
export const repoShort = (r) => (r || '').split('/')[1] || r;
export const keyOf = (repo, n) => `${repo}#${n}`;
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export const ext = (href, ...kids) => el('a', { href, target: '_blank', rel: 'noopener' }, ...kids);
export const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;

// the phases in pipeline order, each with the color token it draws in and the group it counts under
export const PHASES = ['queued', 'working', 'draft', 'ci', 'ready', 'failing', 'blocked', 'stalled', 'parked', 'done'];
export const PHASE = {
  queued: { label: 'queued', tone: 'queued', group: 'queued' },
  working: { label: 'working', tone: 'work', group: 'active' },
  draft: { label: 'draft', tone: 'work', group: 'active' },
  ci: { label: 'in ci', tone: 'ci', group: 'active' },
  ready: { label: 'ready', tone: 'ready', group: 'active' },
  failing: { label: 'failing', tone: 'bad', group: 'attention' },
  blocked: { label: 'blocked', tone: 'bad', group: 'attention' },
  stalled: { label: 'stalled', tone: 'warn', group: 'attention' },
  parked: { label: 'parked', tone: 'parked', group: 'parked' },
  done: { label: 'done', tone: 'done', group: 'done' },
};
export const ATTENTION = new Set(['failing', 'blocked', 'stalled']);
export const RANK = { blocked: 0, failing: 1, stalled: 2, ready: 3, ci: 4, draft: 5, working: 6, queued: 7, parked: 8, done: 9 };

export const phasePill = (p) => el('span', { class: `pill t-${PHASE[p]?.tone || 'queued'}` }, PHASE[p]?.label || p);

// when the work entered the phase it is in now
export function phaseSince(w) {
  const h = w.history || [];
  const last = h[h.length - 1];
  if (last && last.phase === w.phase) return last.at;
  return w.claimedAt || w.queuedAt || w.updatedAt;
}

export function planOf(w) {
  const plan = w.plan || [];
  return { done: plan.filter((s) => s.done).length, total: plan.length, next: plan.find((s) => !s.done) };
}

// the one place the page's state lives. views read it, and change it only through set
export const store = {
  fleet: null,
  config: null,
  route: { view: 'overview', arg: '', q: new URLSearchParams() },
  listeners: new Set(),
  roots: new Map(),
  on(fn) {
    this.listeners.add(fn);
  },
  emit() {
    for (const fn of this.listeners) fn();
  },
  setFleet(f) {
    this.fleet = f;
    this.roots = rootsOf(f.tree || []);
    this.emit();
  },
};

export const FILTERS = ['repo', 'session', 'epic', 'tier', 'q'];

export function filter(name) {
  return store.route.q.get(name) || '';
}

// a link to a view with the current filters, changed by over (a null value clears one). a view's own parameters,
// such as the inbox's kind or the board's grouping, stay in that view: a link to another view carries only FILTERS
export function href(view, arg = '', over = {}) {
  const q = new URLSearchParams(store.route.q);
  if (view !== store.route.view) for (const k of [...q.keys()]) if (!FILTERS.includes(k)) q.delete(k);
  for (const [k, v] of Object.entries(over)) {
    if (v === null || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return `#/${view}${arg ? `/${arg}` : ''}${s ? `?${s}` : ''}`;
}

export function go(view, arg = '', over = {}) {
  location.hash = href(view, arg, over);
}

export function setQuery(over) {
  go(store.route.view, store.route.arg, over);
}

export function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const [view, ...rest] = (path || 'overview').split('/');
  return { view: view || 'overview', arg: decodeURIComponent(rest.join('/')), q: new URLSearchParams(query) };
}

// each issue anywhere under a root epic -> that root's key
export function rootsOf(tree) {
  const out = new Map();
  const walk = (n, root) => {
    out.set(keyOf(n.repo, n.number), root);
    for (const c of n.children) walk(c, root);
  };
  for (const r of tree) walk(r, keyOf(r.repo, r.number));
  return out;
}

// the work the filters let through
export function visibleWork(f = store.fleet) {
  if (!f) return [];
  const repo = filter('repo');
  const session = filter('session');
  const epic = filter('epic');
  const tier = filter('tier');
  const q = filter('q').toLowerCase();
  return f.work.filter(
    (w) =>
      (!repo || w.repo === repo) &&
      (!session || w.owner === session) &&
      (!epic || store.roots.get(keyOf(w.repo, w.issue)) === epic) &&
      (!tier || (w.routing && w.routing.tier) === tier) &&
      (!q || `${w.repo}#${w.issue} ${w.title} ${w.agent || ''}`.toLowerCase().includes(q)),
  );
}

export function visibleTree(f = store.fleet) {
  if (!f) return [];
  const repo = filter('repo');
  const epic = filter('epic');
  const contains = (n) => n.repo === repo || n.children.some(contains);
  return (f.tree || []).filter((t) => (!epic || keyOf(t.repo, t.number) === epic) && (!repo || contains(t)));
}

export function sessionName(s) {
  if (!s) return 'no live session';
  return s.role === 'coordinator' ? 'coordinator' : s.repo ? repoShort(s.repo) : s.title || s.id.slice(0, 8);
}

// choices and routing picks are records for review that never wait on anyone; the rest is addressed to the person or to
// the session owning the work, as src/core/decision.ts has it
export const RECORDS = new Set(['choice', 'routing']);
export const isRecord = (d) => RECORDS.has(d.kind);
export const forYou = (d) => d.state === 'open' && !isRecord(d) && d.to === 'person';
export const forSessions = (d) => d.state === 'open' && !isRecord(d) && d.to === 'session';
export const audience = (d, sessions) => {
  if (d.to === 'person') return 'for you';
  const s = sessions.find((x) => x.id === d.session);
  return `for ${s ? `${sessionName(s)}${s.role === 'other' ? '' : ` ${s.role}`}` : (d.session || '').slice(0, 8)} session`;
};

export const empty = (text, hint) => el('div', { class: 'empty' }, el('div', {}, text), hint ? el('div', { class: 'hint' }, hint) : '');
