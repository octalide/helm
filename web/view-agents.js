import { columns, stack } from './charts.js';
import { at, el, empty, ext, fill, filter, href, issueUrl, keyOf, model, PHASE, phasePill, plural, repoShort, store, visibleWork } from './core.js';
import { agentDot, section } from './parts.js';

const LIVE = new Set(['running', 'pending', 'waiting']);

// helm:issue-opus-5-5-high -> opus 5.5 / high
function typeText(t) {
  const m = /^helm:issue-(.+)-(low|medium|high|xhigh|max)$/.exec(t || '');
  return m ? `issue · ${model(m[1])} / ${m[2]}` : t;
}

export function agents(main) {
  const f = store.fleet;
  const byAgent = new Map(f.work.filter((w) => w.agent).map((w) => [w.agent, w]));
  const live = f.sessions.filter((s) => !s.gone && (!filter('session') || s.id === filter('session')) && (!filter('repo') || s.repo === filter('repo')));
  const gone = f.sessions.filter((s) => s.gone);
  const all = live.flatMap((s) => s.agents);
  const running = all.filter((a) => LIVE.has(a.status));

  const tiles = el(
    'div',
    { class: 'tiles' },
    el('div', { class: 'tile hero' }, el('div', { class: 'tile-label' }, 'Agents running'), el('div', { class: 'tile-value' }, String(running.length)), el('div', { class: 'tile-sub' }, `of ${plural(all.length, 'agent')} in ${plural(live.length, 'live session')}`)),
    el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Issue agents'), el('div', { class: 'tile-value' }, String(all.filter((a) => (a.type || '').startsWith('helm:issue')).length)), el('div', { class: 'tile-sub' }, 'started through dispatch')),
    el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Waiting'), el('div', { class: 'tile-value' }, String(all.filter((a) => a.status === 'waiting' || a.status === 'idle').length)), el('div', { class: 'tile-sub' }, 'ended a turn, resumable')),
    el('div', { class: `tile${all.filter((a) => a.status === 'failed').length ? ' k-bad' : ''}` }, el('div', { class: 'tile-label' }, 'Failed'), el('div', { class: 'tile-value' }, String(all.filter((a) => a.status === 'failed' || a.status === 'killed').length)), el('div', { class: 'tile-sub' }, 'failed or killed')),
  );

  const cards = live.map((s) => {
    const sorted = s.agents.slice().sort((a, b) => LIVE.has(b.status) - LIVE.has(a.status));
    return section(
      el('span', {}, el('span', { class: `chip role-${s.role}` }, s.role), ' ', s.role === 'coordinator' ? 'coordinator' : s.repo || s.title || s.id.slice(0, 8)),
      el('span', { class: 'dim small' }, el('span', { class: 'mono' }, s.id.slice(0, 8)), ` · ${s.cwd.replace(/^\/home\/[^/]+/, '~')} · up `, at(s.startedAt), ' · seen ', at(s.seenAt, ' ago')),
      sorted.length
        ? el(
            'div',
            { class: 'atable' },
            sorted.map((a) => {
              const w = byAgent.get(a.id);
              return el(
                'div',
                { class: `arow2${LIVE.has(a.status) ? '' : ' quiet'}` },
                agentDot({ agent: a.id, agentStatus: a.status }),
                el('div', { class: 'grow' }, el('b', {}, a.name || a.description || a.id.slice(0, 8)), el('div', { class: 'dim small' }, typeText(a.type), a.description && a.name ? ` · ${a.description}` : '')),
                w ? el('a', { class: 'awork', href: href('agents', '', { open: keyOf(w.repo, w.issue) }) }, phasePill(w.phase), ` ${repoShort(w.repo)}#${w.issue}`) : el('span', { class: 'dim small' }, 'no tracked work'),
              );
            }),
          )
        : empty('No agents.'),
    );
  });

  const past = gone.length
    ? el('details', { class: 'history' }, el('summary', {}, `Ended sessions (${gone.length})`), el('div', { class: 'list' }, gone.map((s) => el('div', { class: 'row' }, el('span', { class: `chip role-${s.role}` }, s.role), el('span', { class: 'grow' }, s.repo || s.title || s.id.slice(0, 8), el('span', { class: 'mono dim' }, ` ${s.id.slice(0, 8)}`)), el('span', { class: 'dim' }, `${plural(s.agents.length, 'agent')} · last seen `, at(s.seenAt, ' ago'))))))
    : '';
  fill(main, tiles, ...(cards.length ? cards : [empty('No live sessions.', 'Every Claude Code session with helm enabled registers here.')]), past);
}

export function routing(main) {
  const f = store.fleet;
  const routed = visibleWork(f).filter((w) => w.routing);
  const tiers = (store.config && store.config.routing.tiers) || [];
  const picks = f.decisions.filter((d) => d.kind === 'routing');
  const rerouted = picks.filter((d) => d.state === 'answered' && d.answer && d.answer.option).length;
  const judged = routed.filter((w) => w.routing.by === 'judge');
  const conf = judged.map((w) => w.routing.confidence).filter((c) => typeof c === 'number');
  const mean = conf.length ? Math.round((100 * conf.reduce((a, b) => a + b, 0)) / conf.length) : null;

  const tiles = el(
    'div',
    { class: 'tiles' },
    el('div', { class: 'tile hero' }, el('div', { class: 'tile-label' }, 'Routed'), el('div', { class: 'tile-value' }, String(routed.length)), el('div', { class: 'tile-sub' }, `${judged.length} by the judge · ${routed.filter((w) => w.routing.by === 'caller').length} named · ${routed.filter((w) => w.routing.by === 'human').length} by you`)),
    el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Mean confidence'), el('div', { class: 'tile-value' }, mean === null ? '–' : `${mean}%`), el('div', { class: 'tile-sub' }, `over ${plural(conf.length, 'judged pick')}`)),
    el('div', { class: `tile${picks.filter((d) => d.state === 'open').length ? ' k-warn' : ''}` }, el('div', { class: 'tile-label' }, 'For review'), el('div', { class: 'tile-value' }, String(picks.filter((d) => d.state === 'open').length)), el('div', { class: 'tile-sub' }, el('a', { href: href('review', '', { kind: 'routing' }) }, 'open in review →'))),
    el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, 'Rerouted'), el('div', { class: 'tile-value' }, String(rerouted)), el('div', { class: 'tile-sub' }, `of ${plural(picks.length, 'logged pick')}`)),
  );

  // per tier: its work by outcome. one row per tier, in the configured order
  const names = tiers.map((t) => t.name);
  for (const w of routed) if (w.routing.tier && !names.includes(w.routing.tier)) names.push(w.routing.tier);
  const max = Math.max(1, ...names.map((n) => routed.filter((w) => w.routing.tier === n).length));
  const byTier = section(
    'By tier',
    el('span', { class: 'dim small' }, 'work routed to each tier, by where it stands'),
    names.length
      ? el(
          'div',
          { class: 'tiers' },
          names.map((n) => {
            const mine = routed.filter((w) => w.routing.tier === n);
            const t = tiers.find((x) => x.name === n) || {};
            const g = (grp) => mine.filter((w) => PHASE[w.phase].group === grp).length;
            return el(
              'div',
              { class: 'tier-row' },
              el('div', { class: 'tier-name' }, el('b', {}, n), el('span', { class: 'dim small' }, t.model ? `${model(t.model)} / ${t.effort}` : '')),
              el(
                'div',
                { class: 'tier-bar', style: { width: `${Math.max(4, (100 * mine.length) / max)}%` } },
                stack(
                  [
                    { value: g('done'), tone: 'done', label: 'done' },
                    { value: g('active'), tone: 'work', label: 'active' },
                    { value: g('attention'), tone: 'bad', label: 'needs attention' },
                    { value: g('queued'), tone: 'queued', label: 'queued', hatch: true },
                    { value: g('parked'), tone: 'parked', label: 'parked' },
                  ],
                  mine.length || 1,
                ),
              ),
              el('b', { class: 'tier-n' }, String(mine.length)),
            );
          }),
        )
      : empty('No tiers configured.'),
  );

  const buckets = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}`, value: conf.filter((c) => Math.min(9, Math.floor(c * 10)) === i).length }));
  const hist = section('Judge confidence', el('span', { class: 'dim small' }, `picks under ${Math.round((store.config ? store.config.routing.review : 0.7) * 100)}% are logged for review`), conf.length ? columns(buckets.map((b) => ({ ...b, tip: `${b.label}–${Number(b.label) + 10}%\n${plural(b.value, 'pick')}` })), { tone: 'ready', height: 120, label: 'judged picks by confidence' }) : empty('No judged picks yet.'));

  const table = section(
    'Picks',
    el('span', { class: 'count' }, routed.length || ''),
    routed.length
      ? el(
          'div',
          { class: 'list' },
          routed
            .slice()
            .sort((a, b) => b.routing.at - a.routing.at)
            .map((w) =>
              el(
                'div',
                { class: 'row pick' },
                phasePill(w.phase),
                el('span', { class: 'grow' }, ext(w.issueUrl || issueUrl(w.repo, w.issue), `${repoShort(w.repo)}#${w.issue}`), ' ', w.title, w.routing.reason ? el('div', { class: 'dim small' }, w.routing.reason) : ''),
                el('span', { class: 'chip tier' }, w.routing.tier || model(w.routing.model), el('small', {}, w.routing.effort)),
                el('span', { class: 'dim', 'data-tip': `picked by ${w.routing.by}` }, w.routing.confidence !== undefined ? `${Math.round(w.routing.confidence * 100)}%` : w.routing.by),
                at(w.routing.at),
              ),
            ),
        )
      : empty('Nothing routed yet.', 'dispatch routes each issue to a tier and logs the pick.'),
  );

  fill(main, tiles, el('div', { class: 'grid two' }, byTier, hist), table);
}
