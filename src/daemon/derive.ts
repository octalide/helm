import { verdictOf } from '../core/checks.ts';
import { isOpen } from '../core/decision.ts';
import { workKey } from '../core/protocol.ts';
import { buildTree, emptyRollup } from '../core/tree.ts';
import { inherited, selfWorked } from '../core/work.ts';
import type { AgentStatus, Decision, ForgeState, Issue, Job, LocalState, Phase, Pull, RepoName, Rollup, Session, Subscription, TreeNode, Work, WorkView } from '../core/types.ts';

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
  // an agent adopted work came with is gone with the session that ran it
  if (!owner || owner.gone || inherited(w)) return 'gone';
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

type PhaseContext = { pull?: Pull; agent?: AgentStatus; ownerLive?: boolean; blocking: boolean; issueClosed: boolean; setAside?: boolean; stuck?: boolean; carried?: boolean };

// whether anything is on the work itself: a live agent, one that ended its turn to wait on a delivery that can still
// come, or a live session working it itself
export function activeOf(w: Work, ctx: PhaseContext): boolean {
  const live = ctx.agent !== undefined && LIVE.has(ctx.agent) && !(ctx.stuck && RESTING.has(ctx.agent));
  // an agent that came with adopted work is gone with its session, so what it waited on reaches it no more
  return live || (w.report?.state === 'waiting' && !ctx.stuck && !inherited(w)) || (selfWorked(w) && ctx.ownerLive === true);
}

// stuck: the work's pr subscription held back ci its pr head settled, and a later poll still saw that head.
// carried: another work item on the same open pr has someone on it, so this one moves with that pr
export function phaseOf(w: Work, ctx: PhaseContext): Phase {
  if (w.finished || ctx.issueClosed || ctx.pull?.state === 'merged') return 'done';
  if (ctx.blocking || w.report?.state === 'blocked') return 'blocked';
  // its worker stopped on purpose: set aside until a dispatch, a working report or a resume picks it up again
  if (w.report?.state === 'stopped') return 'parked';
  const active = activeOf(w, ctx) || ctx.carried === true;
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
  if (w.agent === undefined && !selfWorked(w)) return 'queued';
  return active ? 'working' : 'stalled';
}

// an epic is worked through its sub-issues, so its phase is theirs rolled up and never a stall of its own. what is
// said of the epic itself still holds: done, a question on it, or set aside
export function epicPhase(own: Phase, r: Rollup): Phase {
  if (own === 'done' || own === 'blocked' || own === 'parked') return own;
  if (r.total > 0 && r.done === r.total) return 'ready';
  if (r.active || r.attention) return 'working';
  if (r.queued || r.unowned) return 'queued';
  if (r.parked) return 'parked';
  return r.done ? 'working' : 'queued';
}

// what a work item's phase is read from, before anything another work item says about it
function inputsOf(w: Work, forge: ForgeState | undefined, sessions: ReadonlyMap<string, Session>, decisions: readonly Decision[], now: number, subscriptions: readonly Subscription[]) {
  const pull = forge ? pullFor(w.issue, forge.pulls) : undefined;
  const issue = forge?.issues.find((i) => i.number === w.issue);
  const mine = decisions.filter((d) => d.repo === w.repo && d.issue === w.issue && isOpen(d));
  const agentStatus = agentStatusOf(w, sessions, now);
  const open = pull?.state === 'open' ? pull : undefined;
  const stuck =
    open !== undefined &&
    subscriptions.some((s) => s.repo === w.repo && s.session === w.owner && s.agent === w.agent && s.scope.kind === 'pr' && s.scope.number === open.number && s.held?.seen === true && s.held.sha === open.sha);
  const ctx: PhaseContext = { pull, agent: agentStatus, ownerLive: isLive(w.owner ? sessions.get(w.owner) : undefined), blocking: mine.some((d) => d.blocking), issueClosed: issue?.state === 'closed', setAside: setAside(issue), stuck };
  return { w, forge, pull, issue, mine, agentStatus, ctx };
}

function viewFrom(i: ReturnType<typeof inputsOf>, local: LocalState | undefined, carried: boolean): WorkView {
  const { w, forge, pull, issue, mine, agentStatus, ctx } = i;
  const checks = pull?.state === 'open' ? pull.checks : [];
  const runs = new Set(checks.map((c) => c.run).filter((r): r is number => r !== undefined));
  const jobs: Job[] = (forge?.runs ?? []).filter((r) => runs.has(r.id)).flatMap((r) => r.jobs ?? []);
  const worktree = local?.worktrees.find((t) => t.branch !== undefined && (t.branch === pull?.head || branchFor(w.issue, t.branch)));
  return {
    ...w,
    ...(issue && w.title !== issue.title ? { title: issue.title } : {}),
    phase: phaseOf(w, { ...ctx, carried }),
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

// one work item on its own, as if no other work item shared its pr or sat under it
export function viewOf(
  w: Work,
  forge: ForgeState | undefined,
  local: LocalState | undefined,
  sessions: ReadonlyMap<string, Session>,
  decisions: readonly Decision[],
  now: number,
  subscriptions: readonly Subscription[] = [],
): WorkView {
  return viewFrom(inputsOf(w, forge, sessions, decisions, now, subscriptions), local, false);
}

const prKey = (repo: RepoName, pr: number) => `${repo}!${pr}`;

// every work item joined with what the forge, the machine and the ledger say, and with each other: an issue an open
// pr covers moves with whoever is on that pr, and an epic moves with its sub-issues
export function viewsOf(
  work: readonly Work[],
  forges: ReadonlyMap<RepoName, ForgeState>,
  locals: ReadonlyMap<RepoName, LocalState>,
  sessions: ReadonlyMap<string, Session>,
  decisions: readonly Decision[],
  now: number,
  subscriptions: readonly Subscription[] = [],
): WorkView[] {
  const inputs = work.map((w) => inputsOf(w, forges.get(w.repo), sessions, decisions, now, subscriptions));
  // who is on each open pr, by work item
  const on = new Map<string, Set<Work>>();
  for (const i of inputs) {
    // an agent that stopped has let the pr go, whether or not its loop has ended yet
    if (i.pull?.state !== 'open' || i.w.finished || i.w.report?.state === 'stopped' || !activeOf(i.w, i.ctx)) continue;
    const k = prKey(i.w.repo, i.pull.number);
    on.set(k, (on.get(k) ?? new Set()).add(i.w));
  }
  const views = inputs.map((i) => {
    const workers = i.pull?.state === 'open' ? on.get(prKey(i.w.repo, i.pull.number)) : undefined;
    const carried = workers !== undefined && [...workers].some((x) => x !== i.w);
    return viewFrom(i, locals.get(i.w.repo), carried);
  });
  return withEpics(views, forges);
}

// each epic's phase from the rollup of its sub-issues, or from the forge's count of them when helm has not read them
function withEpics(views: WorkView[], forges: ReadonlyMap<RepoName, ForgeState>): WorkView[] {
  const nodes = new Map<string, TreeNode>();
  const walk = (n: TreeNode) => {
    nodes.set(workKey(n.repo, n.number), n);
    n.children.forEach(walk);
  };
  buildTree([...forges.values()], views).forEach(walk);
  return views.map((v) => {
    const node = nodes.get(workKey(v.repo, v.issue));
    const summary = forges.get(v.repo)?.issues.find((i) => i.number === v.issue)?.subIssues;
    let rollup: Rollup | undefined;
    if (node && node.children.length > 0) rollup = node.rollup;
    else if (summary) rollup = { ...emptyRollup(), total: summary.total, done: summary.done };
    if (!rollup) return v;
    const phase = epicPhase(v.phase, rollup);
    return phase === v.phase ? v : { ...v, phase };
  });
}
