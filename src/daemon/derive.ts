import { verdictOf } from '../core/checks.ts';
import { selfWorked } from '../core/work.ts';
import type { AgentStatus, Decision, ForgeState, Issue, Job, LocalState, Phase, Pull, Session, Subscription, Work, WorkView } from '../core/types.ts';

// the branch conventions an issue's work goes on: feat/12, fix/12, hotfix/12, or any prefix ending in the number
export function branchFor(issue: number, branch: string): boolean {
  return new RegExp(`(^|[/-])${issue}$`).test(branch);
}

// the pr that carries an issue's work: one that closes it, else one on its branch; an open one over a finished one
export function pullFor(issue: number, pulls: readonly Pull[]): Pull | undefined {
  const mine = pulls.filter((p) => p.closes.includes(issue) || branchFor(issue, p.head));
  return mine.find((p) => p.state === 'open') ?? mine.find((p) => p.state === 'merged') ?? mine[0];
}

const LIVE: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting', 'idle']);

// a session lists a new agent with its next heartbeat; until then a fresh claim counts as running
const CLAIM_GRACE_MS = 90_000;

export function agentStatusOf(w: Work, sessions: ReadonlyMap<string, Session>, now: number): AgentStatus | undefined {
  if (!w.agent) return undefined;
  const owner = w.owner ? sessions.get(w.owner) : undefined;
  if (!owner || owner.gone) return 'gone';
  const listed = owner.agents.find((a) => a.id === w.agent)?.status;
  if (listed) return listed;
  return w.claimedAt !== undefined && now - w.claimedAt < CLAIM_GRACE_MS ? 'running' : 'gone';
}

const isLive = (s: Session | undefined) => s !== undefined && !s.gone;

const SET_ASIDE_LABELS: ReadonlySet<string> = new Set(['blocked', 'parked']);

// an issue set aside on purpose: labelled blocked or parked, or waiting on an open issue it is blocked by
export function setAside(issue: Issue | undefined): boolean {
  if (!issue) return false;
  return (issue.blockedBy ?? 0) > 0 || issue.labels.some((l) => SET_ASIDE_LABELS.has(l.toLowerCase()));
}

// an agent between turns: on the work only while what it waits on can still come
const RESTING: ReadonlySet<AgentStatus> = new Set(['waiting', 'idle']);

// stuck: the work's pr subscription held back ci its pr head settled, and a later poll still saw that head
export function phaseOf(w: Work, ctx: { pull?: Pull; agent?: AgentStatus; ownerLive?: boolean; blocking: boolean; issueClosed: boolean; setAside?: boolean; stuck?: boolean }): Phase {
  if (w.finished || ctx.issueClosed || ctx.pull?.state === 'merged') return 'done';
  if (ctx.blocking || w.report?.state === 'blocked') return 'blocked';
  // an agent that ended its turn to wait on a delivery is still on the work, unless the delivery can no longer come,
  // and so is a live session working it itself
  const self = selfWorked(w);
  const live = ctx.agent !== undefined && LIVE.has(ctx.agent) && !(ctx.stuck && RESTING.has(ctx.agent));
  const active = live || (w.report?.state === 'waiting' && !ctx.stuck) || (self && ctx.ownerLive === true);
  // set aside with nobody on it is waiting on purpose, not stalled; someone still on it shows where it stands
  if (ctx.setAside && !active) return 'parked';
  if (ctx.stuck && !active) return 'stalled';
  const pull = ctx.pull?.state === 'open' ? ctx.pull : undefined;
  if (pull) {
    const verdict = verdictOf(pull.checks);
    if (verdict === 'failure') return active ? 'failing' : 'stalled';
    if (pull.draft) return active ? 'draft' : 'stalled';
    if (verdict === 'pending') return 'ci';
    return 'ready';
  }
  if (w.agent === undefined && !self) return 'queued';
  return active ? 'working' : 'stalled';
}

export function viewOf(
  w: Work,
  forge: ForgeState | undefined,
  local: LocalState | undefined,
  sessions: ReadonlyMap<string, Session>,
  decisions: readonly Decision[],
  now: number,
  subscriptions: readonly Subscription[] = [],
): WorkView {
  const pull = forge ? pullFor(w.issue, forge.pulls) : undefined;
  const issue = forge?.issues.find((i) => i.number === w.issue);
  const mine = decisions.filter((d) => d.repo === w.repo && d.issue === w.issue && d.state === 'open');
  const agentStatus = agentStatusOf(w, sessions, now);
  const checks = pull?.state === 'open' ? pull.checks : [];
  const runs = new Set(checks.map((c) => c.run).filter((r): r is number => r !== undefined));
  const jobs: Job[] = (forge?.runs ?? []).filter((r) => runs.has(r.id)).flatMap((r) => r.jobs ?? []);
  const open = pull?.state === 'open' ? pull : undefined;
  const stuck =
    open !== undefined &&
    subscriptions.some((s) => s.repo === w.repo && s.session === w.owner && s.agent === w.agent && s.scope.kind === 'pr' && s.scope.number === open.number && s.held?.seen === true && s.held.sha === open.sha);
  const worktree = local?.worktrees.find((t) => t.branch !== undefined && (t.branch === pull?.head || branchFor(w.issue, t.branch)));
  return {
    ...w,
    ...(issue && w.title !== issue.title ? { title: issue.title } : {}),
    phase: phaseOf(w, { pull, agent: agentStatus, ownerLive: isLive(w.owner ? sessions.get(w.owner) : undefined), blocking: mine.some((d) => d.blocking), issueClosed: issue?.state === 'closed', setAside: setAside(issue), stuck }),
    ...(agentStatus ? { agentStatus } : {}),
    ...(pull ? { pull: { number: pull.number, url: pull.url, draft: pull.draft, state: pull.state, head: pull.head, sha: pull.sha } } : {}),
    verdict: verdictOf(checks),
    checks,
    jobs,
    ...(worktree ? { worktree } : {}),
    decisions: mine.length,
    ...(issue ? { issueState: issue.state, issueUrl: issue.url } : {}),
  };
}
