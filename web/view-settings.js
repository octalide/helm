import { api, el, empty, fill, model, store } from './core.js';
import { section } from './parts.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DAY = 24 * 3600_000;

// what the page holds between redraws: the settings as helmd last sent them, the layer being edited, and stale when
// the form has to be built again from them
const S = { view: null, draft: null, error: '', failed: '', note: '', loading: false, saving: false, stale: false };

const clone = (v) => JSON.parse(JSON.stringify(v ?? {}));
const parts = (path) => path.split('.');

function getIn(obj, path) {
  return parts(path).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setIn(obj, path, v) {
  const ks = parts(path);
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  o[ks[ks.length - 1]] = v;
}

// a field dropped from the layer, and its section with it once nothing is left there
function unsetIn(obj, path) {
  const [a, b] = parts(path);
  if (b === undefined) return void delete obj[a];
  if (!obj[a]) return;
  delete obj[a][b];
  if (!Object.keys(obj[a]).length) delete obj[a];
}

const sourceOf = (path) => (getIn(S.draft, path) === undefined ? 'default' : 'user');
const valueOf = (path) => getIn(S.draft, path) ?? getIn(S.view.defaults, path);
const tiers = () => valueOf('routing.tiers');
const dirty = () => JSON.stringify(S.draft) !== JSON.stringify(S.view.layer ?? {});

// the page redraws through the store, so a load or save that ends after the person moved to another view draws nothing
function settled() {
  S.stale = true;
  store.emit();
}

async function load() {
  S.loading = true;
  try {
    S.view = await api('GET', '/v1/settings');
    S.draft = clone(S.view.layer);
    S.error = '';
    S.failed = '';
  } catch (e) {
    S.failed = e.message;
  } finally {
    S.loading = false;
  }
  settled();
}

async function save(main) {
  S.saving = true;
  S.note = '';
  bar(main);
  try {
    S.view = await api('PUT', '/v1/settings', { layer: S.draft, base: S.view.layer });
    S.draft = clone(S.view.layer);
    S.error = '';
    S.note = 'Saved and applied.';
    store.config = await api('GET', '/v1/config').catch(() => store.config);
  } catch (e) {
    S.error = `Not saved, the file is unchanged: ${e.message}`;
  } finally {
    S.saving = false;
  }
  settled();
}

function reload() {
  S.view = null;
  S.error = '';
  S.failed = '';
  S.note = '';
  void load();
  store.emit();
}

export function settings(main) {
  if (!S.view) {
    if (!S.loading && !S.failed) void load();
    delete main.dataset.view;
    if (S.failed) return fill(main, empty('Settings did not load.', S.failed), el('div', { class: 'toolbar' }, el('button', { type: 'button', onclick: reload }, 'retry')));
    return fill(main, empty('Loading settings.'));
  }
  // the form keeps its place across redraws, so an edit in progress keeps its focus and caret
  if (S.stale || main.dataset.view !== 'settings' || !main.querySelector('#set-form')) build(main);
  else spend(main);
}

function build(main) {
  S.stale = false;
  main.dataset.view = 'settings';
  fill(main, el('div', { id: 'set-bar' }), el('div', { id: 'set-form', class: 'settings' }), el('div', { id: 'set-spend' }));
  bar(main);
  form(main);
  spend(main);
}

// a change to the draft: the bar and each field's source follow at once, and structural changes redraw the form
function edit(main, path, v, redraw = false) {
  if (v === undefined) unsetIn(S.draft, path);
  else setIn(S.draft, path, v);
  S.note = '';
  bar(main);
  if (redraw) form(main);
  else for (const n of main.querySelectorAll(`[data-src="${path}"]`)) n.replaceWith(srcChip(main, path));
}

function bar(main) {
  const v = S.view;
  const restart = v.restart.length ? `Saved changes to ${v.restart.join(', ')} apply once helmd restarts; every other field applies at once.` : 'Every field applies as soon as it is saved, without restarting helmd.';
  main.querySelector('#set-bar').replaceChildren(
    el(
      'div',
      { class: 'toolbar set-bar' },
      el('span', { class: 'mono dim' }, v.file),
      el('span', { class: 'grow' }),
      dirty() ? el('span', { class: 'chip' }, 'unsaved changes') : '',
      el('button', { type: 'button', class: 'quiet', disabled: !dirty() || S.saving, onclick: () => ((S.draft = clone(v.layer)), (S.error = ''), build(main)) }, 'discard'),
      el('button', { type: 'button', class: 'quiet', disabled: S.saving, title: 'read the file again, dropping unsaved changes', onclick: reload }, 'reload'),
      el('button', { type: 'button', class: 'primary', disabled: !dirty() || S.saving, onclick: () => save(main) }, S.saving ? 'saving' : 'save'),
    ),
    v.error ? el('div', { class: 'set-msg bad' }, `The file as it stands is not applied: ${v.error}. helmd keeps running the config shown here. Saving replaces the file.`) : '',
    S.error ? el('div', { class: 'set-msg bad', role: 'alert' }, S.error) : '',
    S.note ? el('div', { class: 'set-msg ok', role: 'status' }, S.note) : '',
    el('div', { class: 'dim small set-note' }, `Each field shows where its value comes from: "user" is set in this file, "default" is helm's own. Resetting a field drops it from the file. ${restart}`),
  );
}

function srcChip(main, path) {
  const src = sourceOf(path);
  return el(
    'span',
    { class: 'set-src', 'data-src': path },
    el('span', { class: `chip src-${src}` }, src),
    S.view.restart.includes(path) ? el('span', { class: 'chip' }, 'restart') : '',
    src === 'user' ? el('button', { type: 'button', class: 'mini quiet', title: 'drop this field from the file and use the default', onclick: () => edit(main, path, undefined, true) }, 'reset') : '',
  );
}

// a div, not a label: a label would hand a click anywhere in it to the reset button, its first control
function field(main, path, label, input, hint) {
  input.setAttribute('aria-label', label);
  return el('div', { class: 'set-field' }, el('span', { class: 'set-label' }, label, srcChip(main, path)), input, hint ? el('span', { class: 'dim small' }, hint) : '');
}

function num(main, path, attrs = {}) {
  return el('input', {
    type: 'number',
    value: String(valueOf(path)),
    ...attrs,
    oninput: (e) => edit(main, path, e.target.value === '' ? undefined : Number(e.target.value)),
  });
}

function text(main, path) {
  return el('input', { type: 'text', value: valueOf(path), spellcheck: 'false', oninput: (e) => edit(main, path, e.target.value) });
}

function lines(main, path, placeholder) {
  return el('textarea', {
    rows: '3',
    spellcheck: 'false',
    placeholder,
    oninput: (e) => edit(main, path, e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)),
  }, valueOf(path).join('\n'));
}

function form(main) {
  const general = section(
    'Machine',
    el('span', { class: 'dim small' }, 'where helm looks and what it polls'),
    el(
      'div',
      { class: 'set-grid' },
      field(main, 'roots', 'roots', lines(main, 'roots', '~/dev/src'), 'directories searched for checkouts, one a line'),
      field(main, 'repos', 'repos', lines(main, 'repos', 'owner/name'), 'repositories polled whether or not anything references them, one a line'),
      field(main, 'web.port', 'web.port', num(main, 'web.port', { min: '1', max: '65535', step: '1' }), 'the page moves to the new port once saved'),
    ),
  );
  const poll = section(
    'Polling',
    '',
    el(
      'div',
      { class: 'set-grid' },
      field(main, 'poll.active', 'poll.active', num(main, 'poll.active', { min: '1' }), 'seconds between polls of a repository with work, ci or a subscription in flight'),
      field(main, 'poll.idle', 'poll.idle', num(main, 'poll.idle', { min: '1' }), 'seconds between polls of any other repository'),
      field(main, 'poll.local', 'poll.local', num(main, 'poll.local', { min: '1' }), 'seconds between scans of local git state'),
      field(main, 'poll.stallHours', 'poll.stallHours', num(main, 'poll.stallHours', { min: '0', step: 'any' }), 'checks unfinished this many hours are raised as stalled'),
      field(main, 'poll.goneSeconds', 'poll.goneSeconds', num(main, 'poll.goneSeconds', { min: '1' }), 'a session this many seconds overdue is marked gone'),
    ),
  );
  const fallback = el(
    'select',
    { onchange: (e) => edit(main, 'routing.fallback', e.target.value) },
    tiers().filter((t) => t.judge !== false || t.name === valueOf('routing.fallback')).map((t) => el('option', { value: t.name, selected: t.name === valueOf('routing.fallback') }, t.name)),
  );
  const routing = section(
    'Routing',
    el('span', { class: 'dim small' }, 'how dispatch picks a tier when the caller names none'),
    el(
      'div',
      { class: 'set-grid' },
      field(main, 'routing.judge', 'routing.judge', text(main, 'routing.judge'), 'the model that reads each issue and picks a tier'),
      field(main, 'routing.review', 'routing.review', num(main, 'routing.review', { min: '0', max: '1', step: '0.05' }), 'judge picks under this confidence are flagged for review'),
      field(main, 'routing.fallback', 'routing.fallback', fallback, 'used when the judge fails or picks a tier it may not; never a caller-only tier'),
    ),
    tierEditor(main),
  );
  main.querySelector('#set-form').replaceChildren(routing, el('div', { class: 'grid two' }, general, poll));
}

// tiers replace as a whole, so the first edit copies the effective table into the file
function tierEdit(main, fn) {
  const next = clone(tiers());
  fn(next);
  edit(main, 'routing.tiers', next, true);
}

function tierEditor(main) {
  const list = tiers();
  return el(
    'div',
    { class: 'set-tiers' },
    el('div', { class: 'set-tiers-head' }, el('b', {}, 'Tiers'), el('span', { class: 'dim small' }, ' cheapest first, as the judge reads them'), srcChip(main, 'routing.tiers')),
    list.map((t, i) => {
      const set = (k, v, redraw = false) => {
        const next = clone(tiers());
        if (v === undefined) delete next[i][k];
        else next[i][k] = v;
        edit(main, 'routing.tiers', next, redraw);
      };
      return el(
        'div',
        { class: `set-tier${t.judge === false ? ' caller-only' : ''}` },
        el(
          'div',
          { class: 'set-tier-row' },
          el('input', { type: 'text', class: 'set-tier-name', value: t.name, 'aria-label': 'name', spellcheck: 'false', onchange: (e) => set('name', e.target.value.trim(), true) }),
          el('input', { type: 'text', class: 'set-tier-model', value: t.model, 'aria-label': 'model', spellcheck: 'false', oninput: (e) => set('model', e.target.value.trim()) }),
          el('select', { 'aria-label': 'effort', onchange: (e) => set('effort', e.target.value) }, EFFORTS.map((x) => el('option', { value: x, selected: x === t.effort }, x))),
          el(
            'label',
            { class: 'set-check', title: 'off: caller-only, never offered to the judge and used only when a caller names it' },
            el('input', { type: 'checkbox', checked: t.judge !== false, onchange: (e) => set('judge', e.target.checked ? undefined : false, true) }),
            'judge may pick',
          ),
          el('span', { class: 'grow' }),
          el('button', { type: 'button', class: 'mini', disabled: i === 0, 'aria-label': 'move up', onclick: () => tierEdit(main, (n) => n.splice(i - 1, 0, n.splice(i, 1)[0])) }, '↑'),
          el('button', { type: 'button', class: 'mini', disabled: i === list.length - 1, 'aria-label': 'move down', onclick: () => tierEdit(main, (n) => n.splice(i + 1, 0, n.splice(i, 1)[0])) }, '↓'),
          el('button', { type: 'button', class: 'mini', 'aria-label': 'remove', onclick: () => tierEdit(main, (n) => n.splice(i, 1)) }, 'remove'),
        ),
        el('textarea', { rows: '2', 'aria-label': 'when', placeholder: 'when an issue belongs on this tier, as the judge reads it', oninput: (e) => set('when', e.target.value) }, t.when),
      );
    }),
    el(
      'div',
      { class: 'toolbar' },
      el('button', { type: 'button', onclick: () => tierEdit(main, (n) => n.push({ name: `tier${n.length + 1}`, model: '', effort: 'medium', when: '' })) }, 'add tier'),
    ),
  );
}

function pickCounts(window, by) {
  const now = Date.now();
  const out = new Map();
  for (const p of (store.fleet && store.fleet.picks) || []) {
    if (now - p.at > window || (by && p.by !== by)) continue;
    out.set(p.tier || model(p.model), (out.get(p.tier || model(p.model)) || 0) + 1);
  }
  return out;
}

// where the dispatches went: the picks per tier over the last day and week, beside each tier's model
function spend(main) {
  const host = main.querySelector('#set-spend');
  if (!host || !S.view) return;
  const day = pickCounts(DAY);
  const week = pickCounts(7 * DAY);
  const judged = pickCounts(7 * DAY, 'judge');
  const live = S.view.config.routing.tiers;
  const names = [...live.map((t) => t.name), ...[...week.keys()].filter((n) => !live.some((t) => t.name === n))];
  const max = Math.max(1, ...week.values());
  host.replaceChildren(
    section(
      'Where the dispatches went',
      el('span', { class: 'dim small' }, 'routing picks per tier, as running now; each agent and its model is in Agents'),
      names.length
        ? el(
            'div',
            { class: 'list' },
            el('div', { class: 'row set-spend-head dim small' }, el('span', { class: 'set-spend-tier' }, 'tier'), el('span', { class: 'grow' }, 'last 7 days'), el('span', { class: 'set-spend-n' }, '24h'), el('span', { class: 'set-spend-n' }, '7d'), el('span', { class: 'set-spend-n' }, 'judge')),
            names.map((n) => {
              const t = live.find((x) => x.name === n);
              const w = week.get(n) || 0;
              return el(
                'div',
                { class: 'row' },
                el('span', { class: 'set-spend-tier' }, el('b', {}, n), el('span', { class: 'dim small' }, t ? ` ${model(t.model)} / ${t.effort}` : ' no longer configured'), t && t.judge === false ? el('span', { class: 'chip' }, 'caller-only') : ''),
                el('span', { class: 'grow' }, el('span', { class: 'set-spend-bar', style: { width: `${(100 * w) / max}%` } })),
                el('b', { class: 'set-spend-n' }, String(day.get(n) || 0)),
                el('b', { class: 'set-spend-n' }, String(w)),
                el('span', { class: 'set-spend-n dim' }, String(judged.get(n) || 0)),
              );
            }),
          )
        : empty('No tiers configured.'),
    ),
  );
}
