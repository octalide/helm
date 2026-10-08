import { installTooltip } from './charts.js';
import { $, api, ATTENTION, el, filter, FILTERS, go, href, local, parseRoute, repoShort, sessionName, setQuery, store, tickTimes } from './core.js';
import { renderDrawer } from './drawer.js';
import { installPalette, openPalette } from './palette.js';
import { agents, routing } from './view-agents.js';
import { board } from './view-board.js';
import { ci } from './view-ci.js';
import { epics } from './view-epics.js';
import { activity, inbox, repos } from './view-more.js';
import { overview } from './view-overview.js';
import { timeline } from './view-timeline.js';

const open = (f) => f.work.filter((w) => w.phase !== 'done');

// the views, in nav order; key is the digit that opens it, badge what the nav shows beside it
const VIEWS = [
  { id: 'overview', label: 'Overview', key: '1', icon: 'grid', draw: overview },
  { id: 'board', label: 'Board', key: '2', icon: 'cols', draw: board, badge: (f) => open(f).filter((w) => w.phase !== 'queued').length },
  { id: 'epics', label: 'Epics', key: '3', icon: 'tree', draw: epics, badge: (f) => (f.tree || []).length },
  { id: 'timeline', label: 'Timeline', key: '4', icon: 'gantt', draw: timeline },
  { id: 'ci', label: 'CI', key: '5', icon: 'ci', draw: ci, badge: (f) => Object.values(f.repos).reduce((a, v) => a + (v.forge ? v.forge.runs.filter((r) => r.state === 'queued' || r.state === 'running').length : 0), 0), live: true },
  { id: 'agents', label: 'Agents', key: '6', icon: 'bot', draw: agents, badge: (f) => f.sessions.filter((s) => !s.gone).flatMap((s) => s.agents).filter((a) => ['running', 'pending', 'waiting'].includes(a.status)).length, live: true },
  { id: 'routing', label: 'Routing', key: '7', icon: 'route', draw: routing },
  { id: 'inbox', label: 'Inbox', key: '8', icon: 'inbox', draw: (m) => inbox(m, load), badge: (f) => f.decisions.filter((d) => d.state === 'open').length, alarm: (f) => f.decisions.some((d) => d.state === 'open' && d.blocking) },
  { id: 'repos', label: 'Repos', key: '9', icon: 'repo', draw: repos },
  { id: 'activity', label: 'Activity', key: '0', icon: 'feed', draw: activity },
];

const ICONS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  cols: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  tree: 'M5 4v16M5 8h6M5 14h6M11 6h8v4h-8zM11 12h8v4h-8z',
  gantt: 'M3 6h9M7 12h11M5 18h8',
  ci: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 3',
  bot: 'M6 8h12v10H6zM12 4v4M9 13h.01M15 13h.01',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h6',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  repo: 'M6 3h12v18l-6-4-6 4z',
  feed: 'M4 6h16M4 12h16M4 18h10',
};

const icon = (name) => el('svg', { class: 'ico-svg', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, el('path', { d: ICONS[name] }));

const ACTIONS = [
  { label: 'Toggle theme', key: 't', run: () => toggleTheme() },
  { label: 'Clear filters', key: 'x', run: () => setQuery(Object.fromEntries(FILTERS.map((k) => [k, null]))) },
  { label: 'Keyboard shortcuts', key: '?', run: () => $('keys').showModal() },
];

let loading = false;
let again = false;

async function load() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    store.setFleet(await api('GET', '/v1/fleet'));
    setConn(true);
  } catch (e) {
    setConn(false, e.message);
  } finally {
    loading = false;
    if (again) {
      again = false;
      setTimeout(load, 250);
    }
  }
}

function setConn(live, why) {
  const c = $('conn');
  c.className = `conn ${live ? 'live' : 'down'}`;
  c.textContent = live ? `helmd ${store.fleet ? store.fleet.version : ''}` : 'disconnected';
  c.title = live ? 'live: updates as helmd sees changes' : why || 'helmd is not answering';
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
    timer = setTimeout(load, 300);
  });
  es.addEventListener('error', () => setConn(false));
}

function renderNav() {
  const f = store.fleet;
  $('nav').replaceChildren(
    ...VIEWS.map((v) => {
      const n = f && v.badge ? v.badge(f) : 0;
      return el(
        'a',
        { class: `nav-item${store.route.view === v.id ? ' on' : ''}`, href: href(v.id), 'aria-current': store.route.view === v.id ? 'page' : false, title: `${v.label} (${v.key})` },
        icon(v.icon),
        el('span', { class: 'nav-label' }, v.label),
        n ? el('span', { class: `badge${f && v.alarm && v.alarm(f) ? ' alarm' : ''}${v.live ? ' live' : ''}` }, String(n)) : '',
      );
    }),
  );
}

// the filter bar is built once, so the search box keeps its focus and caret while the page redraws
function buildFilters() {
  const sel = (name, label) => el('label', { class: 'fsel' }, el('span', {}, label), el('select', { id: `f-${name}`, onchange: (e) => setQuery({ [name]: e.target.value || null, open: null }) }));
  const q = el('input', { id: 'f-q', type: 'search', placeholder: 'filter work…  /', autocomplete: 'off' });
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => setQuery({ q: q.value.trim() || null }), 200);
  });
  $('filters').replaceChildren(q, sel('repo', 'repo'), sel('session', 'session'), sel('epic', 'epic'), sel('tier', 'tier'), el('button', { type: 'button', id: 'f-clear', class: 'quiet', onclick: () => setQuery(Object.fromEntries(FILTERS.map((k) => [k, null]))) }, 'clear'));
}

function fillSelect(id, options, value) {
  const s = $(id);
  const want = [['', 'all'], ...options];
  const sig = JSON.stringify(want);
  if (s.dataset.sig !== sig) {
    s.replaceChildren(...want.map(([v, label]) => el('option', { value: v }, label)));
    s.dataset.sig = sig;
  }
  s.value = want.some(([v]) => v === value) ? value : '';
  s.parentElement.classList.toggle('set', Boolean(value));
}

function renderFilters() {
  const f = store.fleet;
  if (!f) return;
  fillSelect('f-repo', Object.keys(f.repos).sort().map((r) => [r, repoShort(r)]), filter('repo'));
  fillSelect('f-session', f.sessions.filter((s) => !s.gone).map((s) => [s.id, `${sessionName(s)} · ${s.id.slice(0, 6)}`]), filter('session'));
  fillSelect('f-epic', (f.tree || []).map((t) => [`${t.repo}#${t.number}`, `${repoShort(t.repo)}#${t.number} ${t.title.replace(/^epic:\s*/i, '').slice(0, 40)}`]), filter('epic'));
  const tiers = (store.config && store.config.routing.tiers.map((t) => t.name)) || [...new Set(f.work.map((w) => w.routing && w.routing.tier).filter(Boolean))];
  fillSelect('f-tier', tiers.map((t) => [t, t]), filter('tier'));
  const q = $('f-q');
  if (document.activeElement !== q) q.value = filter('q');
  $('f-clear').hidden = !FILTERS.some((k) => filter(k));
}

function renderSummary() {
  const f = store.fleet;
  const o = open(f);
  const att = o.filter((w) => ATTENTION.has(w.phase)).length;
  const waiting = f.decisions.filter((d) => d.state === 'open' && d.blocking).length;
  const g = f.rates.graphql;
  const core = f.rates.core;
  $('summary').replaceChildren(
    el('span', {}, el('b', {}, o.filter((w) => w.phase !== 'queued').length), ' active'),
    att ? el('a', { class: 'bad', href: href('board', '', { phase: null }) }, el('b', {}, att), ' attention') : '',
    waiting ? el('a', { class: 'bad', href: href('inbox') }, el('b', {}, waiting), ' waiting on you') : '',
    core ? el('span', { class: 'dim', title: 'REST calls left this hour' }, `rest ${core.remaining}`) : '',
    g ? el('span', { class: 'dim', title: 'GraphQL points left this hour' }, `gql ${g.remaining}`) : '',
  );
  document.title = waiting ? `(${waiting}) helm` : att ? `[${att}] helm` : 'helm';
}

function render() {
  const f = store.fleet;
  renderNav();
  if (!f) return;
  renderFilters();
  renderSummary();
  const v = VIEWS.find((x) => x.id === store.route.view) || VIEWS[0];
  $('view-title').textContent = v.label;
  const main = $('main');
  if (v.id !== 'inbox') delete main.dataset.view;
  const y = window.scrollY;
  const scrollers = [...main.querySelectorAll('.board-wrap, .tl-chart')].map((n) => n.scrollLeft);
  v.draw(main);
  [...main.querySelectorAll('.board-wrap, .tl-chart')].forEach((n, i) => (n.scrollLeft = scrollers[i] || 0));
  if (main.dataset.lastView === v.id) window.scrollTo(0, y);
  main.dataset.lastView = v.id;
  renderDrawer();
}

function onRoute() {
  const was = store.route.view;
  store.route = parseRoute();
  if (store.route.view !== was) window.scrollTo(0, 0);
  local('view', store.route.view);
  render();
}

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  local('theme', t || null);
  $('theme').textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐';
  $('theme').title = `theme: ${t || 'system'} (t)`;
}

function toggleTheme() {
  const now = document.documentElement.dataset.theme;
  const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const cur = now || sys;
  setTheme(cur === 'dark' ? 'light' : 'dark');
}

function typing(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

function keys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      return openPalette(VIEWS, ACTIONS);
    }
    if (e.key === 'Escape') {
      if (typing(e)) return e.target.blur();
      if (filter('open')) return setQuery({ open: null });
      return;
    }
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const v = VIEWS.find((x) => x.key === e.key);
    if (v) return go(v.id);
    if (e.key === '/') return e.preventDefault(), $('f-q').focus();
    if (e.key === 'p') return e.preventDefault(), openPalette(VIEWS, ACTIONS);
    if (e.key === 't') return toggleTheme();
    if (e.key === 'x') return setQuery(Object.fromEntries(FILTERS.map((k) => [k, null])));
    if (e.key === '?') return $('keys').showModal();
    if (e.key === 'j' || e.key === 'k') return stepCards(e.key === 'j' ? 1 : -1);
  });
}

// j and k walk the work cards of the current view
function stepCards(d) {
  const cards = [...document.querySelectorAll('#main .wcard, #main .arow, #main .erow')];
  if (!cards.length) return;
  const i = cards.indexOf(document.activeElement);
  const next = cards[Math.max(0, Math.min(cards.length - 1, i < 0 ? 0 : i + d))];
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

async function boot() {
  setTheme(local('theme'));
  installTooltip();
  installPalette();
  buildFilters();
  $('theme').addEventListener('click', toggleTheme);
  $('pal-open').addEventListener('click', () => openPalette(VIEWS, ACTIONS));
  $('keys-list').replaceChildren(
    ...[...VIEWS.map((v) => [v.key, v.label]), ['ctrl k  p', 'command palette'], ['/', 'filter work'], ['j  k', 'next and previous card'], ['x', 'clear filters'], ['t', 'toggle theme'], ['esc', 'close the drawer'], ['?', 'this list']].map(([k, label]) => el('div', { class: 'krow' }, el('kbd', {}, k), el('span', {}, label))),
  );
  if (!location.hash) location.replace(`#/${local('view') || 'overview'}`);
  store.route = parseRoute();
  store.on(render);
  window.addEventListener('hashchange', onRoute);
  keys();
  setInterval(tickTimes, 15000);
  api('GET', '/v1/config')
    .then((c) => {
      store.config = c;
      render();
    })
    .catch(() => {});
  render();
  connect();
}

boot();
