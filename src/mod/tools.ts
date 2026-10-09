import { forPerson, forSession, isOpen, isRecord } from '../core/decision.ts';
import { workKey } from '../core/protocol.ts';
import { describeScope, parseScope } from '../core/scope.ts';
import { findNode } from '../core/tree.ts';
import type { CiFilter, Decision, ReportState, RepoName, Until } from '../core/types.ts';
import type { HelmClient } from './client.ts';
import { HelmError } from './client.ts';
import { decisionLine, fleetBlock, forgeBlock, jobLines, localBlock, pullLine, sessionLine, subscriptionLine, treeBlock, workBlock } from './format.ts';

export type ToolEnv = {
  client: HelmClient;
  session: () => string;
  home?: string;
  now: () => number;
  // the repository a call is about: the one it names, else the session's
  repo: (given: unknown) => RepoName;
  pending: () => { to: string; count: number }[];
  version: string;
};

// one tool the model calls as mcp__helm__<name>. H is what the hooks layer hands a tool that needs the engine
export type Tool<H = unknown> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // listed with its schema from the first turn, for the tools agents reach for unprompted
  eager: boolean;
  // only the main loop may call it
  mainOnly?: boolean;
  run: (env: ToolEnv, input: Record<string, unknown>, agent: string | undefined, host: H) => Promise<string>;
};

const repoProp = { type: 'string', description: 'owner/name; defaults to the session repository' };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^#?\d+$/.test(v) ? Number(v.replace('#', '')) : undefined);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.map(int).filter((n): n is number => n !== undefined) : int(v) !== undefined ? [int(v)!] : []);

function needInt(v: unknown, what: string): number {
  const n = int(v);
  if (n === undefined) throw new HelmError(400, `${what} must be a positive number`);
  return n;
}

// the open decisions, those for this session first
function inbox(decisions: readonly Decision[], self: string, now: number): string {
  const open = decisions.filter(isOpen);
  return [...open.filter((d) => forSession(d, self)), ...open.filter((d) => !forSession(d, self))].map((d) => decisionLine(d, now, self)).join('\n');
}

const STATES: readonly ReportState[] = ['working', 'waiting', 'blocked', 'ready', 'stopped', 'abandoned'];

export const TOOLS: Tool[] = [
  {
    name: 'status',
    eager: true,
    description:
      'helm status for this session: its role and repository, its work with phases (queued, working, draft, ci, failing, ready, blocked, stalled, parked, done), the decisions addressed to it and its own waiting on the person, its subscriptions, letters waiting for its agents, and the web page. Call it at session start.',
    inputSchema: { type: 'object', properties: {} },
    async run(env) {
      const f = await env.client.fleet();
      const me = f.sessions.find((s) => s.id === env.session());
      const mine = f.work.filter((w) => w.owner === env.session());
      const subs = f.subscriptions.filter((s) => s.session === env.session());
      const forMe = f.decisions.filter((d) => forSession(d, env.session()));
      const asked = f.decisions.filter((d) => forPerson(d) && (d.from?.session === env.session() || mine.some((w) => w.repo === d.repo && w.issue === d.issue)));
      const health = await env.client.health();
      return [
        `helm ${env.version} · helmd ${health.version} · ${health.web ?? ''}`,
        me ? sessionLine(me, f.at, env.session()) : `session ${env.session()} not registered`,
        '',
        'work:',
        workBlock(mine.filter((w) => w.phase !== 'done'), env.home),
        '',
        `decisions for this session (${forMe.length}):`,
        ...forMe.map((d) => decisionLine(d, f.at, env.session())),
        ...(asked.length ? ['', `waiting on the person (${asked.length}):`, ...asked.map((d) => decisionLine(d, f.at, env.session()))] : []),
        '',
        'subscriptions:',
        ...subs.map((s) => subscriptionLine(s, describeScope)),
        ...env.pending().map((p) => `letters waiting for ${p.to}: ${p.count}`),
      ].join('\n');
    },
  },
  {
    name: 'view',
    eager: true,
    description:
      'Read forge and machine state from helm instead of running gh or git: work (this session, or fleet for every session), tree (epics and their sub-issues with progress rolled up, across repositories; number narrows it to one subtree), issues (open, optional label), issue (one, with body and comments), prs (open, with checks), pr (one, with its jobs live), runs (recent workflow runs), worktrees, branches, decisions, sessions. Answers from a shared cache that one poller per repository keeps fresh, so it costs no rate limit.',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['work', 'fleet', 'tree', 'issues', 'issue', 'prs', 'pr', 'runs', 'worktrees', 'branches', 'decisions', 'sessions'] },
        repo: repoProp,
        number: { type: 'number', description: 'issue or pr number, for issue and pr' },
        label: { type: 'string', description: 'issues: only those with this label' },
      },
      required: ['what'],
    },
    async run(env, input) {
      const what = str(input.what) ?? 'work';
      const now = env.now();
      if (what === 'tree') {
        const f = await env.client.fleet(true);
        const n = int(input.number);
        if (n === undefined) return treeBlock(input.repo ? f.tree.filter((t) => t.repo === env.repo(input.repo)) : f.tree);
        const hit = findNode(f.tree, env.repo(input.repo), n);
        if (!hit) return `${env.repo(input.repo)}#${n} is in no epic helm sees`;
        return [...(hit.path.length ? [`under ${hit.path.map((p) => `${p.repo}#${p.number}`).join(' › ')}`] : []), treeBlock([hit.node])].join('\n');
      }
      if (what === 'work' || what === 'fleet' || what === 'decisions' || what === 'sessions') {
        const f = await env.client.fleet();
        if (what === 'fleet') return fleetBlock(f, env.session(), env.home);
        if (what === 'work') return workBlock(f.work.filter((w) => w.owner === env.session() && w.phase !== 'done'), env.home);
        if (what === 'sessions') return f.sessions.map((s) => sessionLine(s, now, env.session())).join('\n') || 'no sessions';
        return inbox(f.decisions, env.session(), now) || 'no open decisions';
      }
      const repo = env.repo(input.repo);
      if (what === 'issue') {
        const i = await env.client.issue(repo, needInt(input.number, 'number'));
        return [`${i.pr ? 'pr' : 'issue'} ${repo}#${i.number} [${i.state}] ${i.title}`, `by ${i.author} · ${i.labels.join(', ') || 'no labels'} · ${i.url}`, '', i.body || '(no body)', ...i.comments.flatMap((c) => ['', `--- ${c.author} ${c.at}`, c.body])].join('\n');
      }
      const view = await env.client.repo(repo);
      if (what === 'pr') {
        const n = needInt(input.number, 'number');
        const p = view.forge?.pulls.find((x) => x.number === n);
        if (!p) return `pr #${n} is not among ${repo}'s open or recently closed pull requests`;
        const runs = new Set(p.checks.map((c) => c.run));
        const jobs = (view.forge?.runs ?? []).filter((r) => runs.has(r.id)).flatMap((r) => r.jobs ?? []);
        return [pullLine(p), p.url, ...jobLines(jobs).map((l) => `  ${l}`), ...(p.lastReview ? [`last review ${p.lastReview.state} by ${p.lastReview.author.login}: ${p.lastReview.text}`] : []), ...(p.lastComment ? [`last comment by ${p.lastComment.author.login}: ${p.lastComment.text}`] : [])].join('\n');
      }
      const polled = view.polling.lastPoll ? `polled ${Math.round((now - view.polling.lastPoll) / 1000)}s ago${view.polling.error ? `, last error: ${view.polling.error}` : ''}` : 'not polled yet';
      if (what === 'issues' || what === 'prs' || what === 'runs') return `${repo} ${what} (${polled})\n${forgeBlock(what, view.forge, now, str(input.label))}`;
      if (what === 'worktrees' || what === 'branches') return localBlock(what, view.local, now, env.home);
      throw new HelmError(400, `unknown view ${what}`);
    },
  },
  {
    name: 'log',
    eager: false,
    description:
      'A CI job log, trimmed: by default the error lines with what led up to them. Name a job, or a run to read every failed job of it. GitHub serves a log only once its job completes; a running job shows its live steps in view pr.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProp,
        run: { type: 'number', description: 'a workflow run id: reads the log of each of its failed jobs' },
        job: { type: 'number', description: 'one job id' },
        grep: { type: 'string', description: 'only lines matching this regular expression' },
        tail: { type: 'number', description: 'the last n lines instead of the errors' },
        errors: { type: 'boolean', description: 'error lines with context (default true unless grep or tail is given)' },
      },
    },
    async run(env, input) {
      const repo = env.repo(input.repo);
      const tail = int(input.tail);
      const grep = str(input.grep);
      const errors = typeof input.errors === 'boolean' ? input.errors : !grep && !tail;
      const q = { ...(tail ? { tail } : {}), ...(grep ? { grep } : {}), errors };
      const job = int(input.job);
      if (job) return env.client.log(repo, job, q);
      const runId = needInt(input.run, 'run or job');
      const view = await env.client.repo(repo);
      const jobs = view.forge?.runs.find((r) => r.id === runId)?.jobs ?? [];
      const failed = jobs.filter((j) => j.state === 'failure' || j.state === 'cancelled');
      if (!failed.length) return jobs.length ? `run ${runId} has no failed job: ${jobLines(jobs).join('; ')}` : `run ${runId} is not among ${repo}'s recent runs, or its jobs are not read yet; pass a job id`;
      const out: string[] = [];
      for (const j of failed.slice(0, 4)) out.push(`=== ${j.name} (job ${j.id}) ${j.url}`, await env.client.log(repo, j.id, q).catch((e: Error) => e.message));
      if (failed.length > 4) out.push(`… ${failed.length - 4} more failed jobs: ${failed.slice(4).map((j) => `${j.name} (${j.id})`).join(', ')}`);
      return out.join('\n');
    },
  },
  {
    name: 'watch',
    eager: true,
    description:
      'Subscribe to repository events, delivered to you as they happen instead of polling. subscribe: scope is repo, issue <n>, pr <n>, branch <name>, run <id> or tag <glob>; ci is settled (every verdict), failures, all or none; until settled, merged, closed or an ISO time removes it once reached. A subagent that subscribes owns the subscription: the delivery rides its next tool call, or after 60 s, or once it has ended its turn, arrives as a message that resumes it. So subscribe, then carry on or end your turn: never sleep or poll. To wait for CI on your PR: subscribe with scope "pr <n>", ci "settled", until "settled", and sha set to the head you pushed. unsubscribe takes the id; list shows this session\'s.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['subscribe', 'unsubscribe', 'list'] },
        repo: repoProp,
        scope: { type: 'string', description: 'repo (default), issue <n>, pr <n>, branch <name>, run <id>, tag <glob>, work or fleet' },
        ci: { type: 'string', enum: ['settled', 'failures', 'all', 'none'] },
        until: { type: 'string', description: 'settled, merged, closed or an ISO time' },
        sha: { type: 'string', description: 'pr scope: the head you pushed, so a verdict on an older head is not taken for yours' },
        tags: { type: 'array', items: { type: 'string' }, description: 'item events to take: opened, closed, reopened, merged, ready, draft, comment, review, pushed, edited, labeled' },
        bots: { type: 'boolean', description: 'take events from bot accounts too' },
        id: { type: 'string', description: 'unsubscribe: the subscription id' },
      },
      required: ['action'],
    },
    async run(env, input, agent) {
      const action = str(input.action);
      if (action === 'list') {
        const f = await env.client.fleet();
        return f.subscriptions.filter((s) => s.session === env.session()).map((s) => subscriptionLine(s, describeScope)).join('\n') || 'no subscriptions';
      }
      if (action === 'unsubscribe') return (await env.client.unsubscribe(str(input.id) ?? '')).removed ? `removed ${String(input.id)}` : `no subscription ${String(input.id)}`;
      if (action !== 'subscribe') throw new HelmError(400, 'action is subscribe, unsubscribe or list');
      const scope = parseScope(str(input.scope));
      const spans = scope.kind === 'work' || scope.kind === 'fleet';
      const untilText = str(input.until);
      const until: Until | undefined = untilText === undefined ? undefined : untilText === 'settled' || untilText === 'merged' || untilText === 'closed' ? untilText : Number.isNaN(Date.parse(untilText)) ? undefined : { at: new Date(Date.parse(untilText)).toISOString() };
      if (untilText !== undefined && until === undefined) throw new HelmError(400, `until ${untilText} is not settled, merged, closed or a time`);
      const sub = await env.client.subscribe({
        session: env.session(),
        scope,
        ...(spans ? {} : { repo: env.repo(input.repo) }),
        ...(str(input.ci) ? { ci: str(input.ci) as CiFilter } : {}),
        ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
        ...(typeof input.bots === 'boolean' ? { bots: input.bots } : {}),
        ...(until ? { until } : {}),
        ...(str(input.sha) ? { sha: str(input.sha)! } : {}),
        ...(agent ? { agent } : {}),
      });
      const who = agent ? `for this agent (${agent}). A delivery arrives with the result of your next tool call; if you make none within 60 s or have ended your turn, it arrives as a message that resumes you. Do not wait or poll: carry on, or end your turn.` : 'for the main loop. Deliveries arrive as prompts, or with the next tool result while a turn runs.';
      return `${subscriptionLine(sub, describeScope)}\nsubscribed ${who}`;
    },
  },
  {
    name: 'report',
    eager: true,
    description:
      'Tell helm where your work on an issue stands, so the person and the session that owns it can track it. Call it with working when you start an issue (this claims it for you), waiting when you end your turn to wait for CI, ready when the PR is ready and green, blocked with a question when you cannot continue without a decision (a question from an agent goes to the session that owns the work, which answers it or escalates it to the person, and one from a session itself goes to the person; the answer resumes you), stopped when you stop for any other reason (this parks the work, and nothing helm delivers resumes you until the issue is dispatched again or your session messages you), abandoned when told to. choices lists decisions you made that the issue did not settle: records for the person to review, which need no answer. plan is your plan as it stands, every step with whether it is done: send it whole each time it changes, so the person sees your progress.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number' },
        repo: repoProp,
        state: { type: 'string', enum: STATES },
        note: { type: 'string', description: 'one line on where it stands' },
        question: {
          type: 'object',
          properties: { title: { type: 'string' }, body: { type: 'string', description: 'what you found, the options and what you would do' }, options: { type: 'array', items: { type: 'string' } } },
          required: ['title', 'body'],
        },
        choices: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } },
        plan: {
          type: 'array',
          description: 'the whole plan, in order, each step one short line',
          items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'] },
        },
      },
      required: ['issue', 'state'],
    },
    async run(env, input, agent) {
      const repo = env.repo(input.repo);
      const issue = needInt(input.issue, 'issue');
      const state = str(input.state) as ReportState;
      if (!STATES.includes(state)) throw new HelmError(400, `state is one of ${STATES.join(', ')}`);
      if (state === 'blocked' && !input.question) throw new HelmError(400, 'blocked needs a question: what decision you need, with the options');
      // a report from an agent claims the issue for it; the session's own report claims it for the session
      if (state === 'working') await env.client.claim({ session: env.session(), repo, issue, ...(agent ? { agent } : {}) });
      const q = input.question as { title?: unknown; body?: unknown; options?: unknown } | undefined;
      const choices = Array.isArray(input.choices) ? (input.choices as { title?: unknown; body?: unknown }[]) : [];
      const plan = Array.isArray(input.plan) ? (input.plan as { text?: unknown; done?: unknown }[]).map((p) => ({ text: String(p.text ?? ''), done: p.done === true })).filter((p) => p.text) : undefined;
      const out = await env.client.report({
        session: env.session(),
        repo,
        issue,
        state,
        ...(agent ? { agent } : {}),
        ...(str(input.note) ? { note: str(input.note)! } : {}),
        ...(q ? { question: { title: String(q.title ?? ''), body: String(q.body ?? ''), ...(Array.isArray(q.options) ? { options: q.options.map(String) } : {}) } } : {}),
        ...(choices.length ? { choices: choices.map((c) => ({ title: String(c.title ?? ''), body: String(c.body ?? '') })) } : {}),
        ...(plan ? { plan } : {}),
      });
      const asked = out.decisions.filter((d) => d.blocking);
      return [
        `${workKey(repo, issue)} reported ${state}`,
        ...out.decisions.map((d) => (isRecord(d) ? `recorded ${d.id} for review (${d.kind}): ${d.title}` : `asked ${d.id} of ${d.to === 'person' ? 'the person' : `session ${d.session}`}: ${d.title}`)),
        ...(asked.length ? ['End your turn now. The answer arrives as a message that resumes you.'] : []),
      ].join('\n');
    },
  },
  {
    name: 'backlog',
    eager: false,
    mainOnly: true,
    description: "This session's backlog of issues, kept in helm so the person sees what the session owns. list, add (issues, queued in order), remove (released), order (issues in the order to work them).",
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'add', 'remove', 'order'] }, repo: repoProp, issues: { type: 'array', items: { type: 'number' } } },
      required: ['action'],
    },
    async run(env, input) {
      const action = str(input.action);
      const issues = ints(input.issues);
      if (action === 'list') {
        const f = await env.client.fleet();
        return workBlock(f.work.filter((w) => w.owner === env.session() && w.phase !== 'done'), env.home);
      }
      if (!issues.length) throw new HelmError(400, 'issues is required');
      const repo = env.repo(input.repo);
      if (action === 'add') return (await env.client.queue({ session: env.session(), repo, issues })).map((w) => `queued ${workKey(w.repo, w.issue)} ${w.title}`).join('\n');
      if (action === 'remove') {
        for (const issue of issues) await env.client.release({ session: env.session(), repo, issue });
        return `released ${issues.map((n) => `#${n}`).join(' ')}`;
      }
      if (action === 'order') {
        await env.client.order({ session: env.session(), keys: issues.map((n) => workKey(repo, n)) });
        return `ordered ${issues.map((n) => `#${n}`).join(' ')}`;
      }
      throw new HelmError(400, 'action is list, add, remove or order');
    },
  },
  {
    name: 'decide',
    eager: false,
    description: 'The decision inbox. list shows the open decisions, each with who it is for: those for this session first (its agents\' questions and its stalls), then the person\'s and other sessions\'. answer one (text and, where it has options, an option; a routing record takes a tier name to reroute), escalate one addressed to this session to the person when its answer is not within this session\'s authority (text is an optional note), or dismiss one. The answer goes to the agent or session waiting on it. Choices and routing picks are records for the person to review, not decisions.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'answer', 'escalate', 'dismiss'] }, id: { type: 'string' }, text: { type: 'string' }, option: { type: 'string' } },
      required: ['action'],
    },
    async run(env, input) {
      const action = str(input.action);
      const id = str(input.id);
      if (action === 'list') {
        const f = await env.client.fleet();
        return inbox(f.decisions, env.session(), f.at) || 'no open decisions';
      }
      if (!id) throw new HelmError(400, 'id is required');
      if (action === 'dismiss') return `dismissed ${(await env.client.dismiss(id)).id}`;
      if (action === 'escalate') return `escalated ${(await env.client.escalate(id, { by: `session ${env.session()}`, ...(str(input.text) ? { note: str(input.text)! } : {}) })).id} to the person`;
      if (action !== 'answer') throw new HelmError(400, 'action is list, answer, escalate or dismiss');
      const out = await env.client.answer(id, { text: str(input.text) ?? '', ...(str(input.option) ? { option: str(input.option)! } : {}), by: `session ${env.session()}` });
      return `answered ${out.decision.id}${out.delivered ? ', delivered' : ', but nobody live was waiting on it'}`;
    },
  },
];
