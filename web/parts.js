// pieces more than one view draws
import { meter, stack } from './charts.js';
import { $, ago, at, done, el, ext, href, issueUrl, keyOf, model, passing, phasePill, phaseSince, planOf, repoShort } from './core.js';

export function ciBar(checks) {
  if (!checks || !checks.length) return '';
  const ok = checks.filter((c) => done(c.state) && passing(c.state)).length;
  const bad = checks.filter((c) => done(c.state) && !passing(c.state)).length;
  const run = checks.filter((c) => c.state === 'running').length;
  return stack(
    [
      { value: ok, tone: 'done', label: 'checks passed' },
      { value: bad, tone: 'bad', label: 'checks failed' },
      { value: run, tone: 'ci', label: 'checks running' },
    ],
    checks.length,
    { size: 'thin', restLabel: 'checks queued' },
  );
}

export function checkText(checks) {
  if (!checks || !checks.length) return '';
  const ok = checks.filter((c) => done(c.state) && passing(c.state)).length;
  const bad = checks.filter((c) => done(c.state) && !passing(c.state)).length;
  const run = checks.length - ok - bad;
  return [bad ? `${bad} failed` : '', run ? `${run} running` : '', `${ok}/${checks.length} passed`].filter(Boolean).join(' · ');
}

export function jobList(repo, jobs, all = false) {
  const shown = all ? jobs : jobs.filter((j) => !done(j.state) || !passing(j.state));
  if (!shown.length) return '';
  return el(
    'ul',
    { class: 'jobs' },
    shown.slice(0, all ? 40 : 10).map((j) => {
      const on = j.steps.find((s) => s.state === 'running');
      const count = j.steps.filter((s) => done(s.state)).length;
      const state = !done(j.state) ? j.state : passing(j.state) ? 'success' : 'failure';
      return el(
        'li',
        { class: state },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        ext(j.url, j.name),
        j.steps.length && !done(j.state) ? meter(count, j.steps.length, `step ${count + (on ? 1 : 0)} of ${j.steps.length}${on ? `\n${on.name}` : ''}`) : '',
        el('span', { class: 'step' }, done(j.state) ? j.state : on ? on.name : j.state),
        done(j.state) && j.startedAt && j.completedAt ? el('span', { class: 'dim' }, ago(Date.parse(j.startedAt), Date.parse(j.completedAt))) : '',
        done(j.state) ? el('button', { type: 'button', class: 'mini', onclick: () => showLog(repo, j) }, 'log') : '',
      );
    }),
  );
}

export async function showLog(repo, job) {
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

export function tierChip(w) {
  if (!w.routing) return '';
  const r = w.routing;
  return el('span', { class: 'chip tier', 'data-tip': `${r.tier || 'tier'}: ${model(r.model)} / ${r.effort}\npicked by ${r.by}${r.confidence !== undefined ? ` at ${Math.round(r.confidence * 100)}%` : ''}${r.reason ? `\n${r.reason}` : ''}` }, r.tier || model(r.model), el('small', {}, r.effort));
}

const AGENT_TONE = { running: 'live', pending: 'live', waiting: 'wait', idle: 'wait', completed: 'off', failed: 'bad', killed: 'bad', gone: 'bad' };

export function agentDot(w) {
  if (!w.agent) return el('span', { class: 'agent none', 'data-tip': 'no agent' }, 'no agent');
  return el('span', { class: `agent ${AGENT_TONE[w.agentStatus] || 'off'}`, 'data-tip': `agent ${w.agent}\n${w.agentStatus || 'unknown'}` }, w.agentStatus || '?');
}

// a work item as a card: what it is, where it stands, what is moving
export function workCard(w, opts = {}) {
  const plan = planOf(w);
  const since = phaseSince(w);
  const card = el(
    'a',
    { class: `wcard p-${w.phase}`, href: href(opts.view || 'board', '', { open: keyOf(w.repo, w.issue) }), 'data-key': keyOf(w.repo, w.issue) },
    el('div', { class: 'wc-head' }, el('span', { class: 'ref' }, `${repoShort(w.repo)}#${w.issue}`), opts.pill === false ? '' : phasePill(w.phase), el('span', { class: 'grow' }), el('span', { class: 'dim', 'data-tip': `in ${w.phase} since ${new Date(since).toLocaleString()}` }, at(since))),
    el('div', { class: 'wc-title' }, w.title),
    el('div', { class: 'wc-meta' }, agentDot(w), tierChip(w), w.pull ? el('span', { class: 'chip' }, `pr #${w.pull.number}${w.pull.draft ? ' draft' : ''}`) : '', w.decisions ? el('span', { class: 'chip bad' }, `${w.decisions} decision${w.decisions === 1 ? '' : 's'}`) : ''),
    plan.total ? el('div', { class: 'wc-plan' }, meter(plan.done, plan.total, `plan ${plan.done} of ${plan.total}${plan.next ? `\nnext: ${plan.next.text}` : ''}`), el('span', { class: 'dim' }, `${plan.done}/${plan.total}`), plan.next ? el('span', { class: 'next' }, plan.next.text) : '') : '',
    w.checks.length ? el('div', { class: 'wc-ci' }, ciBar(w.checks), el('span', { class: 'dim' }, checkText(w.checks))) : '',
    w.report && w.report.note && opts.note !== false ? el('div', { class: 'wc-note' }, w.report.note) : '',
  );
  return card;
}

export function where(d) {
  if (!d.repo) return '';
  return ext(d.issue !== undefined ? issueUrl(d.repo, d.issue) : `https://github.com/${d.repo}`, `${repoShort(d.repo)}${d.issue !== undefined ? `#${d.issue}` : ''}`);
}

export function section(title, extra, ...body) {
  return el('section', { class: 'panel' }, el('header', { class: 'ph' }, el('h2', {}, title), extra || ''), ...body);
}
