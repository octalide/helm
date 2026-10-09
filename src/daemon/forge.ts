import type { Author, Check, CheckState, Child, Issue, Job, Note, Pull, Run, Step } from '../core/types.ts';

const NOTE = 'author{login __typename} createdAt url bodyText';

export const SNAPSHOT_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    defaultBranchRef{name}
    issues(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
      number title url createdAt updatedAt author{login __typename}
      labels(first:20){nodes{name}} assignees(first:5){nodes{login}}
      parent{number repository{nameWithOwner}} subIssuesSummary{total completed} issueDependenciesSummary{blockedBy}
      comments(last:1){totalCount nodes{${NOTE}}}
    }}
    closedIssues:issues(states:CLOSED,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
      number title url createdAt updatedAt closedAt stateReason author{login __typename}
      labels(first:20){nodes{name}} comments{totalCount}
      parent{number repository{nameWithOwner}} subIssuesSummary{total completed}
    }}
    pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
      number title url isDraft createdAt updatedAt author{login __typename}
      headRefName headRefOid isCrossRepository baseRefName mergeable reviewDecision
      closingIssuesReferences(first:10){nodes{number}}
      comments(last:1){totalCount nodes{${NOTE}}}
      reviews(last:1){totalCount nodes{author{login __typename} state submittedAt url bodyText}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        __typename
        ... on CheckRun{databaseId name status conclusion detailsUrl startedAt completedAt checkSuite{workflowRun{databaseId workflow{name}}}}
        ... on StatusContext{context state targetUrl createdAt}
      }}}}}}
    }}
    closedPulls:pullRequests(states:[MERGED,CLOSED],first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
      number title url isDraft createdAt updatedAt closedAt merged author{login __typename}
      headRefName headRefOid baseRefName closingIssuesReferences(first:10){nodes{number}}
      comments{totalCount} reviews{totalCount}
    }}
  }
}`;

type GqlAuthor = { login: string; __typename: string } | null;
type GqlNote = { author: GqlAuthor; createdAt?: string; submittedAt?: string; url: string; bodyText: string; state?: string };
// a count-only connection (totalCount alone) comes back with no nodes
type GqlConnection<T> = { totalCount?: number; nodes: T[] };
type GqlCount<T> = { totalCount?: number; nodes?: T[] };
type GqlCheck =
  | {
      __typename: 'CheckRun';
      databaseId: number;
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      startedAt: string | null;
      completedAt: string | null;
      checkSuite: { workflowRun: { databaseId: number; workflow: { name: string } } | null } | null;
    }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null; createdAt: string };

type GqlIssue = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  stateReason?: string | null;
  author: GqlAuthor;
  labels: GqlConnection<{ name: string }>;
  assignees?: GqlConnection<{ login: string }>;
  parent?: { number: number; repository: { nameWithOwner: string } } | null;
  subIssuesSummary?: { total: number; completed: number };
  // blockedBy counts the open issues blocking it, totalBlockedBy the closed ones too
  issueDependenciesSummary?: { blockedBy: number };
  comments: GqlCount<GqlNote>;
};

type GqlPull = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  merged?: boolean;
  author: GqlAuthor;
  headRefName: string;
  headRefOid: string;
  isCrossRepository?: boolean;
  baseRefName: string;
  mergeable?: string;
  reviewDecision?: string | null;
  closingIssuesReferences: GqlConnection<{ number: number }>;
  comments: GqlCount<GqlNote>;
  reviews: GqlCount<GqlNote>;
  commits?: GqlConnection<{ commit: { statusCheckRollup: { contexts: GqlConnection<GqlCheck> } | null } }>;
};

export type Snapshot = {
  repository: {
    defaultBranchRef: { name: string } | null;
    issues: GqlConnection<GqlIssue>;
    closedIssues: GqlConnection<GqlIssue>;
    pullRequests: GqlConnection<GqlPull>;
    closedPulls: GqlConnection<GqlPull>;
  } | null;
};

const NOTE_CHARS = 600;

function author(a: GqlAuthor): Author {
  return a ? { login: a.login, bot: a.__typename === 'Bot' } : { login: 'ghost', bot: false };
}

function note(n: GqlNote | undefined): Note | undefined {
  if (!n) return undefined;
  const text = n.bodyText.length > NOTE_CHARS ? `${n.bodyText.slice(0, NOTE_CHARS)}…` : n.bodyText;
  return { author: author(n.author), at: n.createdAt ?? n.submittedAt ?? '', url: n.url, text };
}

export function checkRunState(status: string, conclusion: string | null): CheckState {
  const s = status.toLowerCase();
  if (s === 'in_progress') return 'running';
  if (s !== 'completed') return 'queued';
  switch ((conclusion ?? '').toLowerCase()) {
    case 'success':
      return 'success';
    case 'neutral':
      return 'neutral';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failure';
  }
}

function statusState(state: string): CheckState {
  switch (state.toLowerCase()) {
    case 'success':
      return 'success';
    case 'pending':
      return 'running';
    case 'expected':
      return 'queued';
    default:
      return 'failure';
  }
}

function check(c: GqlCheck): Check {
  if (c.__typename === 'StatusContext') {
    return { name: c.context, state: statusState(c.state), ...(c.targetUrl ? { url: c.targetUrl } : {}), startedAt: c.createdAt };
  }
  const run = c.checkSuite?.workflowRun;
  return {
    name: c.name,
    state: checkRunState(c.status, c.conclusion),
    ...(c.detailsUrl ? { url: c.detailsUrl } : {}),
    ...(run ? { job: c.databaseId, run: run.databaseId, workflow: run.workflow.name } : {}),
    ...(c.startedAt ? { startedAt: c.startedAt } : {}),
    ...(c.completedAt ? { completedAt: c.completedAt } : {}),
  };
}

function summary(s: { total: number; completed: number } | undefined): { subIssues?: { total: number; done: number } } {
  return s && s.total > 0 ? { subIssues: { total: s.total, done: s.completed } } : {};
}

function issue(i: GqlIssue, state: 'open' | 'closed'): Issue {
  return {
    number: i.number,
    title: i.title,
    url: i.url,
    state,
    ...(i.stateReason ? { reason: i.stateReason.toLowerCase() } : {}),
    author: author(i.author),
    labels: i.labels.nodes.map((l) => l.name).sort(),
    assignees: (i.assignees?.nodes ?? []).map((a) => a.login),
    ...(i.parent ? { parent: { repo: i.parent.repository.nameWithOwner, number: i.parent.number } } : {}),
    ...(summary(i.subIssuesSummary)),
    ...(i.issueDependenciesSummary?.blockedBy ? { blockedBy: i.issueDependenciesSummary.blockedBy } : {}),
    comments: i.comments.totalCount ?? 0,
    ...(i.comments.nodes?.[0] ? { lastComment: note(i.comments.nodes[0]) } : {}),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    ...(i.closedAt ? { closedAt: i.closedAt } : {}),
  };
}

function pull(p: GqlPull): Pull {
  const contexts = p.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const review = p.reviews.nodes?.[0];
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.merged ? 'merged' : p.closedAt ? 'closed' : 'open',
    draft: p.isDraft,
    author: author(p.author),
    head: p.headRefName,
    sha: p.headRefOid,
    ...(p.isCrossRepository ? { fork: true } : {}),
    base: p.baseRefName,
    closes: p.closingIssuesReferences.nodes.map((n) => n.number),
    ...(p.reviewDecision ? { review: p.reviewDecision.toLowerCase() } : {}),
    ...(p.mergeable ? { mergeable: p.mergeable.toLowerCase() } : {}),
    comments: p.comments.totalCount ?? 0,
    ...(p.comments.nodes?.[0] ? { lastComment: note(p.comments.nodes[0]) } : {}),
    reviews: p.reviews.totalCount ?? 0,
    ...(review ? { lastReview: { ...note(review)!, state: (review.state ?? '').toLowerCase() } } : {}),
    checks: contexts.map(check),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.closedAt ? { closedAt: p.closedAt } : {}),
  };
}

export function fromSnapshot(s: Snapshot): { defaultBranch: string; issues: Issue[]; pulls: Pull[] } {
  const r = s.repository;
  if (!r) throw new Error('repository not found or not visible to the token');
  return {
    defaultBranch: r.defaultBranchRef?.name ?? 'main',
    issues: [...r.issues.nodes.map((i) => issue(i, 'open')), ...r.closedIssues.nodes.map((i) => issue(i, 'closed'))],
    pulls: [...r.pullRequests.nodes.map(pull), ...r.closedPulls.nodes.map(pull)],
  };
}

type RestRun = {
  id: number;
  name: string | null;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  actor?: { login: string } | null;
  created_at: string;
  updated_at: string;
};

// the sub-issues of each of the given issues, in one query: each issue is its own alias
export function childrenQuery(numbers: readonly number[]): string {
  const parts = numbers.map((n) => `i${n}:issue(number:${n}){subIssues(first:100){nodes{number title url state repository{nameWithOwner} subIssuesSummary{total completed}}}}`);
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${parts.join(' ')}}}`;
}

type GqlChild = { number: number; title: string; url: string; state: string; repository: { nameWithOwner: string }; subIssuesSummary?: { total: number; completed: number } };
export type ChildrenRead = { repository: Record<string, { subIssues: GqlConnection<GqlChild> } | null> };

export function fromChildren(read: ChildrenRead): Record<number, Child[]> {
  const out: Record<number, Child[]> = {};
  for (const [alias, node] of Object.entries(read.repository)) {
    if (!node) continue;
    out[Number(alias.slice(1))] = node.subIssues.nodes.map((c) => ({
      repo: c.repository.nameWithOwner,
      number: c.number,
      title: c.title,
      url: c.url,
      state: c.state === 'CLOSED' ? 'closed' : 'open',
      ...summary(c.subIssuesSummary),
    }));
  }
  return out;
}

export type RestRuns = { workflow_runs: RestRun[] };

export function fromRuns(body: RestRuns): Run[] {
  return body.workflow_runs.map((r) => ({
    id: r.id,
    workflow: r.name ?? 'workflow',
    branch: r.head_branch ?? '',
    sha: r.head_sha,
    event: r.event,
    state: checkRunState(r.status ?? 'queued', r.conclusion),
    url: r.html_url,
    actor: r.actor?.login ?? 'ghost',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

type RestJob = {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: { number: number; name: string; status: string; conclusion: string | null }[];
};

export type RestJobs = { jobs: RestJob[] };

export function fromJobs(body: RestJobs): Job[] {
  return body.jobs.map((j) => ({
    id: j.id,
    run: j.run_id,
    name: j.name,
    state: checkRunState(j.status, j.conclusion),
    url: j.html_url,
    steps: (j.steps ?? []).map((s): Step => ({ number: s.number, name: s.name, state: checkRunState(s.status, s.conclusion) })),
    ...(j.started_at ? { startedAt: j.started_at } : {}),
    ...(j.completed_at ? { completedAt: j.completed_at } : {}),
  }));
}
