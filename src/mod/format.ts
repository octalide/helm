import { isDone, isPassing, verdictOf } from '../core/checks.ts';
import { rollupText } from '../core/tree.ts';
import { selfWorked } from '../core/work.ts';
import type { Branch, Check, Decision, Fleet, ForgeState, Issue, Job, LocalState, Pull, Run, Session, Subscription, TreeNode, Worktree, WorkView } from '../core/types.ts';

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

const tidy = (path: string, home?: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);

export function checkSummary(checks: readonly Check[]): string {
  if (!checks.length) return 'no checks';
  const done = checks.filter((c) => isDone(c.state)).length;
  const failed = checks.filter((c) => isDone(c.state) && !isPassing(c.state));
  const v = verdictOf(checks);
  return `ci ${v} ${done}/${checks.length}${failed.length ? `, failed: ${failed.map((c) => c.name).join(', ')}` : ''}`;
}

// a job in flight with the step it is on; a finished one with its outcome
export function jobLine(j: Job): string {
  if (isDone(j.state)) return `${j.name}: ${j.state} (job ${j.id})`;
  const on = j.steps.find((s) => s.state === 'running') ?? j.steps.find((s) => s.state === 'queued');
  const done = j.steps.filter((s) => isDone(s.state)).length;
  return `${j.name}: ${j.state}${j.steps.length ? ` step ${done + (on ? 1 : 0)}/${j.steps.length}${on ? ` ${on.name}` : ''}` : ''}`;
}

// jobs worth a line: what runs and what failed; the passing rest are counted
export function jobLines(jobs: readonly Job[]): string[] {
  const live = jobs.filter((j) => !isDone(j.state) || !isPassing(j.state));
  const passed = jobs.length - live.length;
  return [...live.map(jobLine), ...(passed ? [`${passed} job${passed === 1 ? '' : 's'} passed`] : [])];
}

export function workLine(v: WorkView, home?: string): string {
  const parts = [
    v.agent ? `agent ${v.agent} ${v.agentStatus ?? '?'}` : selfWorked(v) ? 'worked by its session' : 'no agent',
    v.routing ? `${v.routing.tier ?? ''}${v.routing.tier ? ' ' : ''}${v.routing.model}/${v.routing.effort}` : '',
    v.plan?.length ? `plan ${v.plan.filter((p) => p.done).length}/${v.plan.length}` : '',
    v.pull ? `pr #${v.pull.number}${v.pull.draft ? ' draft' : ''}` : '',
    v.checks.length ? checkSummary(v.checks) : '',
    v.worktree ? `${tidy(v.worktree.path, home)}${v.worktree.dirty ? ` dirty ${v.worktree.dirty}` : ''}` : '',
    v.decisions ? `${v.decisions} decision${v.decisions === 1 ? '' : 's'} open` : '',
    v.report ? `reported ${v.report.state}${v.report.note ? `: ${v.report.note}` : ''}` : '',
  ].filter(Boolean);
  const next = v.plan?.find((p) => !p.done);
  const left = (v.leftovers ?? []).map((p) => `\n  left running: pid ${p.pid} ${p.command}`).join('');
  return `${v.repo}#${v.issue} [${v.phase}] ${v.title}\n  ${parts.join(' · ')}${next ? `\n  next: ${next.text}` : ''}${left}`;
}

// the hierarchy as an indented outline, each epic with what its subtree adds up to
export function treeBlock(roots: readonly TreeNode[]): string {
  if (!roots.length) return 'no epics: an issue with sub-issues in a watched repository is one';
  const out: string[] = [];
  const walk = (n: TreeNode, depth: number, from: string) => {
    const pad = '  '.repeat(depth);
    const name = n.repo === from ? `#${n.number}` : `${n.repo}#${n.number}`;
    const tag = n.children.length || n.external ? 'epic' : (n.phase ?? (n.state === 'closed' ? 'done' : 'open'));
    const who = [n.agent ? `agent ${n.agent}` : '', n.tier ?? '', n.plan ? `plan ${n.plan.done}/${n.plan.total}` : ''].filter(Boolean).join(' ');
    const sum = n.children.length || n.external ? ` · ${rollupText(n.rollup)}${n.external ? ' (not watched)' : ''}` : '';
    out.push(`${pad}${name} [${tag}] ${n.title}${who ? ` · ${who}` : ''}${sum}`);
    for (const c of n.children) walk(c, depth + 1, n.repo);
  };
  for (const r of roots) walk(r, 0, '');
  return out.join('\n');
}

export function workBlock(views: readonly WorkView[], home?: string): string {
  if (!views.length) return 'no work';
  return views.map((v) => [workLine(v, home), ...jobLines(v.jobs).filter((l) => !/passed$/.test(l)).map((l) => `    ${l}`)].join('\n')).join('\n');
}

export function issueLine(i: Issue): string {
  const extra = [i.labels.length ? `[${i.labels.join(', ')}]` : '', i.comments ? `${i.comments} comments` : '', i.parent ? `parent ${i.parent.repo}#${i.parent.number}` : '', i.subIssues ? `sub ${i.subIssues.done}/${i.subIssues.total}` : '', i.assignees.length ? `@${i.assignees.join(' @')}` : '']
    .filter(Boolean)
    .join(' ');
  return `#${i.number} ${i.title}${extra ? ` ${extra}` : ''}`;
}

export function pullLine(p: Pull): string {
  const state = p.state === 'open' ? (p.draft ? 'draft' : 'open') : p.state;
  const extra = [p.closes.length ? `closes ${p.closes.map((n) => `#${n}`).join(' ')}` : '', p.review ? `review ${p.review}` : '', p.mergeable && p.mergeable !== 'mergeable' ? p.mergeable : ''].filter(Boolean).join(' · ');
  return `#${p.number} [${state}] ${p.head} → ${p.base}: ${p.title}\n  ${[p.state === 'open' ? checkSummary(p.checks) : '', extra].filter(Boolean).join(' · ')}`;
}

export function runLine(r: Run, now: number): string {
  const jobs = r.jobs ?? [];
  const running = jobs.filter((j) => !isDone(j.state)).length;
  return `run ${r.id} ${r.workflow} on ${r.tag ? 'tag ' : ''}${r.branch} @${r.sha.slice(0, 7)} (${r.event}) ${r.state}${running ? `, ${running} job${running === 1 ? '' : 's'} running` : ''} · ${ago(Date.parse(r.updatedAt), now)} ago`;
}

export function worktreeLine(w: Worktree, home?: string): string {
  const sync = w.ahead !== undefined ? ` +${w.ahead}/-${w.behind ?? 0} ${w.upstream ?? ''}` : w.upstream ? '' : ' no upstream';
  return `${tidy(w.path, home)} ${w.branch ?? `(detached @${w.sha.slice(0, 7)})`}${w.main ? ' main' : ''}${w.dirty ? ` dirty ${w.dirty}` : ' clean'}${sync}${w.locked ? ' locked' : ''}`;
}

export function branchLine(b: Branch, now: number): string {
  const sync = b.gone ? 'upstream gone' : b.upstream ? `${b.upstream}${b.ahead ? ` +${b.ahead}` : ''}${b.behind ? ` -${b.behind}` : ''}` : 'local only';
  return `${b.name} @${b.sha.slice(0, 7)} ${sync} · ${ago(b.committedAt, now)} ago`;
}

export function decisionLine(d: Decision, now: number): string {
  const where = d.repo ? ` ${d.repo}${d.issue !== undefined ? `#${d.issue}` : ''}` : '';
  const state = d.state === 'open' ? (d.blocking ? 'waiting' : 'review') : d.state;
  const answer = d.answer ? `\n  answer by ${d.answer.by}: ${d.answer.option ? `${d.answer.option} ` : ''}${d.answer.text}` : '';
  return `${d.id} [${d.kind}, ${state}]${where}: ${d.title} · ${ago(d.createdAt, now)} ago${d.options?.length ? `\n  options: ${d.options.join(' | ')}` : ''}${d.body ? `\n  ${d.body.split('\n').join('\n  ')}` : ''}${answer}`;
}

export function sessionLine(s: Session, now: number, self?: string): string {
  const live = s.agents.filter((a) => a.status === 'running' || a.status === 'pending' || a.status === 'waiting').length;
  return `${s.id}${s.id === self ? ' (this session)' : ''} ${s.role}${s.repo ? ` ${s.repo}` : ''}${s.title ? ` "${s.title}"` : ''} · ${s.agents.length} agents, ${live} live · ${s.gone ? 'gone' : 'seen'} ${ago(s.seenAt, now)} ago`;
}

export function subscriptionLine(s: Subscription, describe: (s: Subscription) => string): string {
  return `${s.id} ${describe(s)} · ci ${s.ci}${s.tags ? ` · tags ${s.tags.join(',')}` : ''}${s.until ? ` · until ${typeof s.until === 'object' ? s.until.at : s.until}` : ''}${s.agent ? ` · for agent ${s.agent}` : ''}`;
}

export function forgeBlock(what: 'issues' | 'prs' | 'runs', f: ForgeState | undefined, now: number, label?: string): string {
  if (!f) return 'not polled yet';
  if (what === 'issues') {
    const open = f.issues.filter((i) => i.state === 'open' && (!label || i.labels.includes(label)));
    return open.length ? open.map(issueLine).join('\n') : 'no open issues';
  }
  if (what === 'prs') {
    const open = f.pulls.filter((p) => p.state === 'open');
    return open.length ? open.map(pullLine).join('\n') : 'no open pull requests';
  }
  return f.runs.length ? f.runs.slice(0, 20).map((r) => runLine(r, now)).join('\n') : 'no workflow runs';
}

export function localBlock(what: 'worktrees' | 'branches', l: LocalState | undefined, now: number, home?: string): string {
  if (!l) return 'no local checkout found under the configured roots';
  if (what === 'worktrees') return l.worktrees.map((w) => worktreeLine(w, home)).join('\n') || 'no worktrees';
  return l.branches.slice(0, 40).map((b) => branchLine(b, now)).join('\n') || 'no branches';
}

export function fleetBlock(f: Fleet, self: string | undefined, home?: string): string {
  const live = f.sessions.filter((s) => !s.gone);
  const open = f.decisions.filter((d) => d.state === 'open');
  const bySession = new Map<string, WorkView[]>();
  for (const w of f.work.filter((x) => x.phase !== 'done')) bySession.set(w.owner ?? 'unowned', [...(bySession.get(w.owner ?? 'unowned') ?? []), w]);
  const lines = [`sessions ${live.length} live · work ${f.work.filter((w) => w.phase !== 'done').length} open · decisions ${open.filter((d) => d.blocking).length} waiting, ${open.filter((d) => !d.blocking).length} for review`];
  for (const s of live) {
    lines.push('', sessionLine(s, f.at, self));
    const mine = bySession.get(s.id) ?? [];
    if (mine.length) lines.push(...workBlock(mine, home).split('\n').map((l) => `  ${l}`));
    bySession.delete(s.id);
  }
  for (const [owner, views] of bySession) lines.push('', `${owner} (not live)`, ...workBlock(views, home).split('\n').map((l) => `  ${l}`));
  return lines.join('\n');
}
