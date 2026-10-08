import { columns, stack } from './charts.js';
import { at, done, dur, el, empty, ext, filter, passing, plural, repoShort, setQuery, store } from './core.js';
import { jobList, section } from './parts.js';

const length = (r) => Date.parse(r.updatedAt) - Date.parse(r.createdAt);
const outcome = (s) => (!done(s) ? 'run' : passing(s) ? 'ok' : s === 'cancelled' ? 'off' : 'bad');
const MARK = { ok: '✓', bad: '✗', run: '●', off: '–' };

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function ci(main) {
  const repo = filter('repo');
  const failedOnly = filter('failed') === '1';
  const runs = Object.entries(store.fleet.repos)
    .filter(([r]) => !repo || r === repo)
    .flatMap(([r, v]) => (v.forge ? v.forge.runs.map((run) => ({ repo: r, run })) : []))
    .sort((a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt));
  const live = runs.filter((x) => !done(x.run.state));
  const day = runs.filter((x) => done(x.run.state) && Date.now() - Date.parse(x.run.updatedAt) < 86400_000);
  const ok = day.filter((x) => passing(x.run.state)).length;
  const rate = day.length ? Math.round((100 * ok) / day.length) : null;

  const tiles = el(
    'div',
    { class: 'tiles' },
    el('div', { class: 'tile hero' }, el('div', { class: 'tile-label' }, 'In flight'), el('div', { class: 'tile-value' }, String(live.length)), el('div', { class: 'tile-sub' }, `${live.reduce((a, x) => a + (x.run.jobs || []).filter((j) => j.state === 'running').length, 0)} jobs running`)),
    el('div', { class: `tile${rate !== null && rate < 80 ? ' k-bad' : ''}` }, el('div', { class: 'tile-label' }, 'Passing, 24h'), el('div', { class: 'tile-value' }, rate === null ? '–' : `${rate}%`), el('div', { class: 'tile-sub' }, `${ok} of ${plural(day.length, 'run')}`)),
    el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Median run, 24h'), el('div', { class: 'tile-value' }, day.length ? dur(median(day.map((x) => length(x.run)))) : '–'), el('div', { class: 'tile-sub' }, 'created to last update')),
    el('div', { class: `tile${day.length - ok ? ' k-bad' : ''}` }, el('div', { class: 'tile-label' }, 'Failed, 24h'), el('div', { class: 'tile-value' }, String(day.length - ok)), el('div', { class: 'tile-sub' }, [...new Set(day.filter((x) => !passing(x.run.state)).map((x) => x.run.workflow))].join(', ') || 'none')),
  );

  const flight = section(
    'In flight',
    el('span', { class: 'count' }, live.length || ''),
    live.length
      ? live.map(({ repo, run }) => {
          const jobs = run.jobs || [];
          return el(
            'div',
            { class: 'runcard' },
            el('div', { class: 'cihead' }, el('span', { class: 'pulse', 'aria-hidden': 'true' }), ext(run.url, el('b', {}, run.workflow)), el('span', { class: 'dim' }, ` ${repoShort(repo)} · ${run.tag ? 'tag ' : ''}${run.branch} @${run.sha.slice(0, 7)} · ${run.event} by ${run.actor}`), el('span', { class: 'grow' }), 'started ', at(Date.parse(run.createdAt), ' ago')),
            stack(
              [
                { value: jobs.filter((j) => j.state === 'success' || j.state === 'skipped').length, tone: 'done', label: 'jobs passed' },
                { value: jobs.filter((j) => done(j.state) && !passing(j.state)).length, tone: 'bad', label: 'jobs failed' },
                { value: jobs.filter((j) => j.state === 'running').length, tone: 'ci', label: 'jobs running' },
              ],
              jobs.length || 1,
              { restLabel: 'jobs queued' },
            ),
            jobs.length ? jobList(repo, jobs, true) : el('div', { class: 'dim small' }, 'jobs not read yet'),
          );
        })
      : empty('No run in flight.'),
  );

  // per workflow and repository: the last runs' outcomes as a strip, newest right
  const flows = new Map();
  for (const x of runs) {
    const k = `${x.repo}\u0000${x.run.workflow}`;
    if (!flows.has(k)) flows.set(k, { repo: x.repo, workflow: x.run.workflow, runs: [] });
    flows.get(k).runs.push(x.run);
  }
  const health = section(
    'Workflows',
    el('span', { class: 'dim small' }, 'recent runs, newest right'),
    flows.size
      ? el(
          'div',
          { class: 'flows' },
          [...flows.values()].map((fl) => {
            const fin = fl.runs.filter((r) => done(r.state));
            const pass = fin.filter((r) => passing(r.state)).length;
            return el(
              'div',
              { class: 'flow' },
              el('div', { class: 'flow-name' }, el('b', {}, fl.workflow), el('span', { class: 'dim' }, ` ${repoShort(fl.repo)}`)),
              el('div', { class: 'strip-dots' }, fl.runs.slice(0, 20).reverse().map((r) => el('a', { class: `rd o-${outcome(r.state)}`, href: r.url, target: '_blank', rel: 'noopener', 'data-tip': `${r.workflow} on ${r.branch}\n${r.state} · ${dur(length(r))}\n${new Date(r.createdAt).toLocaleString()}` }, MARK[outcome(r.state)]))),
              el('div', { class: 'dim small' }, fin.length ? `${Math.round((100 * pass) / fin.length)}% pass · median ${dur(median(fin.map(length)))}` : 'none finished'),
            );
          }),
        )
      : empty('No runs read yet.'),
  );

  const durations = section(
    'Run length',
    el('span', { class: 'dim small' }, 'the last 30 finished runs, oldest left'),
    (() => {
      const fin = runs.filter((x) => done(x.run.state)).slice(0, 30).reverse();
      if (!fin.length) return empty('No finished runs.');
      return columns(
        fin.map((x) => ({ label: new Date(x.run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), value: Math.round(length(x.run) / 60000), tip: `${x.run.workflow} · ${repoShort(x.repo)} ${x.run.branch}\n${x.run.state} · ${dur(length(x.run))}` })),
        { tone: 'ready', height: 130, label: 'run length in minutes' },
      );
    })(),
    el('div', { class: 'dim small' }, 'minutes'),
  );

  const recent = runs.filter((x) => done(x.run.state) && (!failedOnly || !passing(x.run.state))).slice(0, 40);
  const list = section(
    'Recent runs',
    el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: failedOnly, onchange: (e) => setQuery({ failed: e.target.checked ? '1' : null }) }), 'failed only'),
    recent.length
      ? el(
          'div',
          { class: 'list' },
          recent.map(({ repo, run }) =>
            el(
              'div',
              { class: 'row' },
              el('span', { class: `rd o-${outcome(run.state)}`, 'aria-label': run.state }, MARK[outcome(run.state)]),
              el('span', { class: 'grow' }, ext(run.url, run.workflow), el('span', { class: 'dim' }, ` ${repoShort(repo)} · ${run.tag ? 'tag ' : ''}${run.branch} `), el('span', { class: 'mono dim' }, `@${run.sha.slice(0, 7)} ${run.event}`), !passing(run.state) && run.jobs ? jobList(repo, run.jobs) : ''),
              el('span', { class: 'dim' }, `${run.state} · ${dur(length(run))} · `, at(Date.parse(run.updatedAt), ' ago')),
            ),
          ),
        )
      : empty(failedOnly ? 'No failed runs.' : 'No finished runs.'),
  );

  main.replaceChildren(tiles, flight, el('div', { class: 'grid two' }, health, durations), list);
}
