// the contract between helmd, the mod and the web page. plain json data only: everything here crosses a socket

export type RepoName = string;

export type Author = { login: string; bot: boolean };

export type Note = { author: Author; at: string; url: string; text: string };

export type IssueRef = { repo: RepoName; number: number };

// one sub-issue as its parent lists it; its repository may be one helm does not poll
export type Child = IssueRef & { title: string; url: string; state: 'open' | 'closed'; subIssues?: { total: number; done: number } };

export type Issue = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  // why it closed, as the forge says it (completed, not_planned, duplicate)
  reason?: string;
  author: Author;
  labels: string[];
  assignees: string[];
  parent?: IssueRef;
  subIssues?: { total: number; done: number };
  // open issues it is blocked by, as github's issue dependencies record them; read for open issues only
  blockedBy?: number;
  comments: number;
  lastComment?: Note;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type CheckState = 'queued' | 'running' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled';

// one check on a commit: a check run (with its actions job and run when it has one) or a commit status
export type Check = {
  name: string;
  state: CheckState;
  url?: string;
  job?: number;
  run?: number;
  workflow?: string;
  startedAt?: string;
  completedAt?: string;
};

export type Verdict = 'pending' | 'success' | 'failure' | 'none';

export type Pull = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: Author;
  head: string;
  sha: string;
  base: string;
  closes: number[];
  review?: string;
  mergeable?: string;
  comments: number;
  lastComment?: Note;
  reviews: number;
  lastReview?: Note & { state: string };
  checks: Check[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type Step = { number: number; name: string; state: CheckState };

export type Job = {
  id: number;
  run: number;
  name: string;
  state: CheckState;
  url: string;
  steps: Step[];
  startedAt?: string;
  completedAt?: string;
};

export type Run = {
  id: number;
  workflow: string;
  branch: string;
  sha: string;
  event: string;
  state: CheckState;
  url: string;
  actor: string;
  // ref is a tag, not a branch
  tag?: boolean;
  createdAt: string;
  updatedAt: string;
  // jobs are read only while the run is in flight and once when it completes
  jobs?: Job[];
};

// what the forge holds for one repository, as of the last poll
export type ForgeState = {
  repo: RepoName;
  defaultBranch: string;
  issues: Issue[];
  pulls: Pull[];
  runs: Run[];
  // issue number -> its sub-issues, for every issue here that has any
  children: Record<number, Child[]>;
  polledAt: number;
};

export type Worktree = {
  path: string;
  branch?: string;
  sha: string;
  main: boolean;
  dirty: number;
  ahead?: number;
  behind?: number;
  upstream?: string;
  locked?: boolean;
};

export type Branch = {
  name: string;
  sha: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  gone?: boolean;
  committedAt: number;
};

// what the machine holds for one repository: its checkouts, their worktrees and the local branches
export type LocalState = {
  repo: RepoName;
  checkouts: string[];
  worktrees: Worktree[];
  branches: Branch[];
  scannedAt: number;
};

export type SessionRole = 'coordinator' | 'repo' | 'other';

// the engine's agent statuses, and gone for one no live session lists
export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' | 'gone';

export type AgentRecord = {
  id: string;
  name?: string;
  type: string;
  description: string;
  status: AgentStatus;
  parentId?: string;
};

export type Session = {
  id: string;
  role: SessionRole;
  repo?: RepoName;
  cwd: string;
  title?: string;
  agents: AgentRecord[];
  startedAt: number;
  seenAt: number;
  // set once a heartbeat is overdue; a session that comes back clears it
  gone?: boolean;
};

export type Tier = {
  name: string;
  model: string;
  effort: Effort;
  // when an issue belongs on this tier, read by the routing judge
  when: string;
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type Routing = {
  tier?: string;
  model: string;
  effort: Effort;
  by: 'judge' | 'caller' | 'human';
  confidence?: number;
  reason?: string;
  at: number;
};

// what an agent says about its own work: the states only it can know
export type ReportState = 'working' | 'waiting' | 'blocked' | 'ready' | 'stopped' | 'abandoned';

export type Report = { state: ReportState; note?: string; at: number };

export type PlanStep = { text: string; done: boolean };

// one issue in the ledger: queued in a session's backlog, then worked by one agent at a time
export type Work = {
  repo: RepoName;
  issue: number;
  title: string;
  owner?: string;
  order: number;
  agent?: string;
  routing?: Routing;
  report?: Report;
  // the agent's plan as it last reported it
  plan?: PlanStep[];
  // when the work entered each phase, oldest first
  history?: { phase: Phase; at: number }[];
  queuedAt: number;
  claimedAt?: number;
  updatedAt: number;
  finished?: { at: number; how: 'merged' | 'closed' | 'abandoned' };
};

// parked: set aside on purpose (a blocked or parked label, or an open blocked-by) with nobody on it
export type Phase = 'queued' | 'working' | 'draft' | 'ci' | 'failing' | 'ready' | 'blocked' | 'stalled' | 'parked' | 'done';

// a work item joined with what the forge, the machine and the ledger say about it now
export type WorkView = Work & {
  phase: Phase;
  agentStatus?: AgentStatus;
  pull?: Pick<Pull, 'number' | 'url' | 'draft' | 'state' | 'head' | 'sha'>;
  verdict: Verdict;
  checks: Check[];
  jobs: Job[];
  worktree?: Worktree;
  decisions: number;
  issueState?: 'open' | 'closed';
  issueUrl?: string;
};

// what a subtree of the hierarchy adds up to, counted over its leaves
export type Rollup = {
  total: number;
  done: number;
  // worked by an agent: working, draft, ci or ready
  active: number;
  // blocked, failing or stalled
  attention: number;
  ci: number;
  // ready to merge, also counted active
  ready: number;
  queued: number;
  // set aside on purpose; neither active nor attention
  parked: number;
  // open with nobody on it
  unowned: number;
};

export type TreeNode = IssueRef & {
  title: string;
  url: string;
  state: 'open' | 'closed';
  // the work item's phase when the ledger has one, done when closed, absent when open and unowned
  phase?: Phase;
  owner?: string;
  agent?: string;
  tier?: string;
  plan?: { done: number; total: number };
  // a sub-epic in a repository helm does not poll: counted from its summary, its children unknown
  external?: boolean;
  children: TreeNode[];
  rollup: Rollup;
};

export type DecisionKind = 'routing' | 'question' | 'choice' | 'stall' | 'failure';

export type Answer = { text: string; option?: string; by: string; at: number };

// who a decision is for: the person, or the session that owns the work it concerns
export type Audience = 'person' | 'session';

export type Decision = {
  id: string;
  kind: DecisionKind;
  repo?: RepoName;
  issue?: number;
  title: string;
  body: string;
  options?: string[];
  // true when someone is stopped until it is answered
  blocking: boolean;
  from?: { session: string; agent?: string };
  to: Audience;
  // the session it is addressed to, set exactly when to is session
  session?: string;
  // handed on to the person: by the session it was addressed to, or by helm once that session is gone
  escalated?: { by: string; note?: string; at: number };
  state: 'open' | 'answered' | 'dismissed' | 'resolved';
  answer?: Answer;
  // a condition helmd raised and clears itself once it no longer holds
  key?: string;
  // what held when it was raised; a dismissal holds against it until the condition changes or ends
  condition?: string;
  createdAt: number;
  updatedAt: number;
};

export type Scope =
  | { kind: 'repo' }
  | { kind: 'issue'; number: number }
  | { kind: 'pr'; number: number }
  | { kind: 'branch'; name: string }
  | { kind: 'run'; id: number }
  | { kind: 'tag'; glob: string }
  // the work items the subscriber's session owns, across repositories
  | { kind: 'work' }
  // every work item, decision and session, across the machine
  | { kind: 'fleet' };

export type CiFilter = 'settled' | 'failures' | 'all' | 'none';

export type Until = 'settled' | 'merged' | 'closed' | { at: string };

export type Subscription = {
  id: string;
  // absent for the work and fleet scopes, which span repositories
  repo?: RepoName;
  scope: Scope;
  ci: CiFilter;
  // the item tags delivered; absent takes the defaults
  tags?: string[];
  bots: boolean;
  until?: Until;
  session: string;
  agent?: string;
  createdAt: number;
};

export type EventKind = 'issue' | 'pr' | 'ci' | 'work' | 'decision' | 'epic';

export type HelmEvent = {
  id: string;
  kind: EventKind;
  repo?: RepoName;
  at: number;
  // what the event is about, matched against scopes
  issue?: number;
  pr?: number;
  branch?: string;
  run?: number;
  sha?: string;
  tag?: string;
  // tags a filter reads: opened, closed, merged, comment, review, ready, draft, edited, labeled, settled, stalled,
  // completed, success, failure, phase, decision, answered, progress, complete
  tags: string[];
  author?: Author;
  // one line, then detail lines
  text: string;
  detail?: string[];
  url?: string;
  // the session whose work it is, for the work scope
  owner?: string;
  // the root epic a work event rolls up into, whose progress event speaks for it on the fleet scope
  epic?: string;
};

// one delivery to a session, or to one agent of it
export type Letter = {
  id: string;
  session: string;
  agent?: string;
  text: string;
  events: string[];
  subs: string[];
  at: number;
};

// a lite view carries only polling and the runs in flight or just finished, what a pane draws its ci from
export type RepoView = { forge?: ForgeState; local?: LocalState; polling: PollStatus; runs?: Run[] };

export type PollStatus = {
  active: boolean;
  interval: number;
  lastPoll?: number;
  lastChange?: number;
  error?: string;
  failures: number;
};

export type Fleet = {
  version: string;
  sessions: Session[];
  work: WorkView[];
  decisions: Decision[];
  subscriptions: Subscription[];
  repos: Record<RepoName, RepoView>;
  // every epic in the watched repositories that no other epic here holds, with its subtree
  tree: TreeNode[];
  // the newest events, newest last; absent from a lite answer
  events?: HelmEvent[];
  rates: Record<string, { remaining: number; limit: number; resetAt: number }>;
  at: number;
};
