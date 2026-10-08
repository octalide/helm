// ctrl-k: jump to any view, work item, epic, repository or session, or run an action
import { $, el, go, keyOf, phasePill, repoShort, sessionName, store } from './core.js';

let entries = [];
let pick = 0;

function collect(views, actions) {
  const f = store.fleet;
  const out = [...views.map((v) => ({ kind: 'view', text: v.label, hint: v.key ? `${v.key}` : '', run: () => go(v.id) })), ...actions.map((a) => ({ kind: 'action', text: a.label, hint: a.key || '', run: a.run }))];
  if (!f) return out;
  for (const w of f.work) out.push({ kind: 'work', text: `${repoShort(w.repo)}#${w.issue} ${w.title}`, phase: w.phase, run: () => go(store.route.view, store.route.arg, { open: keyOf(w.repo, w.issue) }) });
  const walk = (n) => {
    if (n.children.length) out.push({ kind: 'epic', text: `${repoShort(n.repo)}#${n.number} ${n.title}`, run: () => go('epics', keyOf(n.repo, n.number)) });
    n.children.forEach(walk);
  };
  (f.tree || []).forEach(walk);
  for (const r of Object.keys(f.repos)) out.push({ kind: 'repo', text: r, run: () => go(store.route.view, store.route.arg, { repo: r }) });
  for (const s of f.sessions.filter((x) => !x.gone)) out.push({ kind: 'session', text: `${sessionName(s)} ${s.id.slice(0, 8)}`, run: () => go('board', '', { session: s.id }) });
  return out;
}

// every query character in order, earlier and tighter matches first
function score(text, q) {
  const t = text.toLowerCase();
  if (!q) return 1;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, i);
    if (j < 0) return 0;
    gaps += j - i;
    i = j + 1;
  }
  return 500 - gaps;
}

function draw() {
  const q = $('pal-input').value.trim().toLowerCase();
  const hits = entries
    .map((e) => ({ e, s: score(`${e.kind} ${e.text}`, q) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map((h) => h.e);
  pick = Math.min(pick, Math.max(0, hits.length - 1));
  $('pal-list').replaceChildren(
    ...hits.map((e, i) =>
      el(
        'li',
        { class: i === pick ? 'on' : '', role: 'option', 'aria-selected': String(i === pick), onmousedown: (ev) => (ev.preventDefault(), choose(e)), onmousemove: () => i !== pick && ((pick = i), draw()) },
        el('span', { class: 'pk' }, e.kind),
        e.phase ? phasePill(e.phase) : '',
        el('span', { class: 'grow' }, e.text),
        e.hint ? el('kbd', {}, e.hint) : '',
      ),
    ),
  );
  if (!hits.length) $('pal-list').replaceChildren(el('li', { class: 'none' }, 'nothing matches'));
  $('pal-list').dataset.count = String(hits.length);
  return hits;
}

function choose(e) {
  $('palette').close();
  e.run();
}

export function openPalette(views, actions) {
  entries = collect(views, actions);
  pick = 0;
  $('pal-input').value = '';
  $('palette').showModal();
  $('pal-input').focus();
  draw();
}

export function installPalette() {
  $('pal-input').addEventListener('input', () => ((pick = 0), draw()));
  $('pal-input').addEventListener('keydown', (e) => {
    const hits = draw();
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) (pick = Math.min(hits.length - 1, pick + 1)), draw(), e.preventDefault();
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) (pick = Math.max(0, pick - 1)), draw(), e.preventDefault();
    else if (e.key === 'Enter' && hits[pick]) e.preventDefault(), choose(hits[pick]);
  });
  $('palette').addEventListener('click', (e) => e.target === $('palette') && $('palette').close());
}
