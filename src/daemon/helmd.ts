import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Config, mergeConfig, repoLayer } from '../core/config.ts';
import type { AnswerBody, Answered, ClaimBody, ConfigView, DecisionBody, IssueDetail, QueueBody, RegisterBody, ReportBody, StreamFrame, SubscribeBody } from '../core/protocol.ts';
import { workKey } from '../core/protocol.ts';
import type { HelmPaths } from '../core/paths.ts';
import type { AgentRecord, Decision, Fleet, ForgeState, HelmEvent, Letter, LocalState, Phase, PollStatus, RepoName, RepoView, Session, SessionRole, Subscription, WorkView } from '../core/types.ts';
import { route } from './deliver.ts';
import { pullFor, viewOf } from './derive.ts';
import type { GitHub } from './github.ts';
import { emptyLedger, Ledger, type LedgerData } from './ledger.ts';
import { discover, type Git, git as realGit, scan } from './local.ts';
import { readJson, Saver, writeJson } from './persist.ts';
import { emptyCache, type RepoCache, RepoPoller } from './poller.ts';
import type { MatchContext } from './watch.ts';

export type DaemonDeps = {
  paths: HelmPaths;
  config: Config;
  gh: GitHub;
  version: string;
  now?: () => number;
  log?: (line: string) => void;
  git?: Git;
  // off in tests, which drive polls by hand
  loops?: boolean;
};

type Poll = PollStatus & { due: number; running: boolean };

// how many repositories poll at once
const POLL_CONCURRENCY = 3;
// a repository asked about by a tool or the page stays polled this long after the last ask
const ASKED_MS = 30 * 60_000;
// checkouts are searched for again this often
const DISCOVER_MS = 10 * 60_000;
// below this many calls left in a pool, every poll waits for the window to reset
const RATE_FLOOR = 150;
const LOG_TAIL = 200;

export class Daemon {
  readonly startedAt: number;
  readonly version: string;
  config: Config;
  ledger: Ledger;
  private readonly paths: HelmPaths;
  private readonly gh: GitHub;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly git: Git;
  private readonly loops: boolean;
  private readonly pollers = new Map<RepoName, RepoPoller>();
  private readonly savers = new Map<RepoName, Saver>();
  private readonly local = new Map<RepoName, LocalState>();
  private checkouts = new Map<RepoName, string[]>();
  private discoveredAt = 0;
  private readonly polls = new Map<RepoName, Poll>();
  private readonly asked = new Map<RepoName, number>();
  private phases?: Map<string, Phase>;
  private readonly streams = new Map<string, Set<(f: StreamFrame) => void>>();
  private readonly watchers = new Set<(f: StreamFrame) => void>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private ledgerSaver!: Saver;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private scanning = false;

  constructor(deps: DaemonDeps) {
    this.paths = deps.paths;
    this.config = deps.config;
    this.gh = deps.gh;
    this.version = deps.version;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.git = deps.git ?? realGit;
    this.loops = deps.loops ?? true;
    this.startedAt = this.now();
    this.ledger = new Ledger(emptyLedger(), this.now);
  }

  async start(): Promise<void> {
    const data = (await readJson<LedgerData>(this.paths.ledger)) ?? emptyLedger();
    this.ledger = new Ledger(data, this.now, () => this.changed());
    this.ledgerSaver = new Saver(this.paths.ledger, () => this.ledger.data, (e) => this.log(`ledger save failed: ${e.message}`));
    for (const repo of this.watched()) await this.poller(repo);
    this.refreshViews();
    if (!this.loops) return;
    this.timers.push(setInterval(() => void this.schedule(), 1000));
    this.timers.push(setInterval(() => void this.scanLocal(), this.config.poll.local * 1000));
    this.timers.push(setInterval(() => this.sweep(), 15_000));
    void this.scanLocal();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.notifyTimer);
    clearTimeout(this.refreshTimer);
    await this.ledgerSaver?.flush();
    await Promise.all([...this.savers.values()].map((s) => s.flush()));
  }

  // every repository polled now: the configured ones, those a live session works in, those with unfinished work or a
  // subscription, and those a tool or the page asked about lately
  watched(): Set<RepoName> {
    const now = this.now();
    const d = this.ledger.data;
    const out = new Set<RepoName>(this.config.repos);
    for (const s of Object.values(d.sessions)) if (!s.gone && s.repo) out.add(s.repo);
    for (const w of Object.values(d.work)) if (!w.finished) out.add(w.repo);
    for (const s of Object.values(d.subscriptions)) if (s.repo) out.add(s.repo);
    for (const [repo, at] of this.asked) if (now - at < ASKED_MS) out.add(repo);
    return out;
  }

  private active(repo: RepoName): boolean {
    if (this.pollers.get(repo)?.busy()) return true;
    const d = this.ledger.data;
    if (Object.values(d.work).some((w) => w.repo === repo && !w.finished && w.agent)) return true;
    return Object.values(d.subscriptions).some((s) => s.repo === repo && s.scope.kind !== 'repo');
  }

  private async poller(repo: RepoName): Promise<RepoPoller> {
    const held = this.pollers.get(repo);
    if (held) return held;
    const file = join(this.paths.repos, `${repo.replace('/', '__')}.json`);
    const cache = (await readJson<RepoCache>(file).catch(() => undefined)) ?? emptyCache();
    const p = new RepoPoller(repo, this.gh, cache, () => this.config.poll.stallHours * 3600_000);
    this.pollers.set(repo, p);
    this.savers.set(repo, new Saver(file, () => p.cache, (e) => this.log(`${repo} cache save failed: ${e.message}`)));
    return p;
  }

  private async schedule(): Promise<void> {
    const now = this.now();
    const watched = this.watched();
    for (const repo of this.polls.keys()) if (!watched.has(repo)) this.polls.delete(repo);
    let running = [...this.polls.values()].filter((p) => p.running).length;
    const floor = this.rateWait(now);
    for (const repo of watched) {
      const st = this.polls.get(repo) ?? { active: false, interval: 0, failures: 0, due: 0, running: false };
      this.polls.set(repo, st);
      if (st.running || now < st.due || now < floor || running >= POLL_CONCURRENCY) continue;
      running++;
      void this.pollRepo(repo);
    }
  }

  // when the next poll may go: now, or the reset of a pool that is nearly spent
  private rateWait(now: number): number {
    let until = now;
    for (const r of Object.values(this.gh.rates)) if (r.remaining < RATE_FLOOR && r.resetAt > until) until = r.resetAt;
    return until;
  }

  async pollRepo(repo: RepoName, force = false): Promise<void> {
    const st = this.polls.get(repo) ?? { active: false, interval: 0, failures: 0, due: 0, running: false };
    this.polls.set(repo, st);
    if (st.running) return;
    st.running = true;
    try {
      const p = await this.poller(repo);
      const { changed, events } = await p.poll(this.now(), force);
      this.savers.get(repo)?.save();
      st.failures = 0;
      delete st.error;
      st.lastPoll = this.now();
      if (changed) st.lastChange = st.lastPoll;
      if (events.length) this.handle(repo, events);
      if (changed) this.changed();
    } catch (error) {
      st.failures++;
      st.error = (error as Error).message;
      this.log(`${repo} poll failed (${st.failures}): ${st.error}`);
    } finally {
      st.running = false;
      st.active = this.active(repo);
      const base = st.active ? this.config.poll.active : this.config.poll.idle;
      st.interval = st.failures ? Math.min(this.config.poll.idle * 4, base * 2 ** st.failures) : base;
      st.due = this.now() + st.interval * 1000;
    }
  }

  private async scanLocal(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = this.now();
      if (now - this.discoveredAt > DISCOVER_MS) {
        this.checkouts = await discover(this.config.roots, this.git);
        this.discoveredAt = now;
      }
      let moved = false;
      for (const repo of this.watched()) {
        const checkouts = this.checkouts.get(repo);
        if (!checkouts?.length) continue;
        const was = this.local.get(repo);
        if (was && !this.active(repo) && now - was.scannedAt < 60_000) continue;
        const next = await scan(repo, checkouts, now, this.git);
        if (!was || JSON.stringify({ ...was, scannedAt: 0 }) !== JSON.stringify({ ...next, scannedAt: 0 })) moved = true;
        this.local.set(repo, next);
      }
      if (moved) this.changed();
    } catch (error) {
      this.log(`local scan failed: ${(error as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private sweep(): void {
    const gone = this.ledger.sweep(this.config.poll.goneSeconds * 1000);
    for (const s of gone) this.log(`session ${s.id} went quiet`);
    const now = this.now();
    for (const s of Object.values(this.ledger.data.subscriptions)) {
      if (typeof s.until === 'object' && Date.parse(s.until.at) <= now) this.ledger.unsubscribe(s.id);
    }
    this.refreshViews();
  }

  // what an event means for the ledger beyond its delivery: finished work, and conditions raised or cleared
  private handle(repo: RepoName, events: HelmEvent[]): void {
    const forge = this.pollers.get(repo)?.forge;
    for (const e of events) {
      if (e.kind === 'issue' && e.issue !== undefined && e.tags.includes('closed')) this.ledger.finish(repo, e.issue, 'closed');
      if (e.kind === 'pr' && e.pr !== undefined && e.tags.includes('merged')) {
        const pull = forge?.pulls.find((p) => p.number === e.pr);
        for (const w of Object.values(this.ledger.data.work)) {
          if (w.repo === repo && !w.finished && pull && pullFor(w.issue, [pull])) this.ledger.finish(repo, w.issue, 'merged');
        }
      }
      if (e.kind === 'ci' && e.pr !== undefined) {
        if (e.tags.includes('stalled')) {
          const raised = this.ledger.raise(`stall:ci:${repo}#${e.pr}`, { kind: 'stall', repo, title: `CI stalled on pr #${e.pr}`, body: [e.text, ...(e.detail ?? []), e.url ?? ''].join('\n'), blocking: false, ...this.prIssue(repo, e.pr) });
          if (raised) this.announce(raised);
        }
        if (e.tags.includes('settled')) this.ledger.resolveKey(`stall:ci:${repo}#${e.pr}`);
      }
      if (e.kind === 'ci' && e.run !== undefined && e.branch && this.lasting(repo, e.branch)) {
        const run = forge?.runs.find((r) => r.id === e.run);
        const key = `failure:${repo}:${run?.workflow ?? ''}:${e.branch}`;
        if (e.tags.includes('failure')) {
          const raised = this.ledger.raise(key, { kind: 'failure', repo, title: `${run?.workflow ?? 'CI'} failing on ${e.branch}`, body: [e.text, e.url ?? ''].join('\n'), blocking: false });
          if (raised) this.announce(raised);
        }
        if (e.tags.includes('success')) this.ledger.resolveKey(key);
      }
    }
    this.dispatch(events);
  }

  private prIssue(repo: RepoName, pr: number): { issue?: number } {
    const pull = this.pollers.get(repo)?.forge?.pulls.find((p) => p.number === pr);
    const w = Object.values(this.ledger.data.work).find((x) => x.repo === repo && pull && pullFor(x.issue, [pull]));
    return w ? { issue: w.issue } : {};
  }

  private lasting(repo: RepoName, branch: string): boolean {
    const def = this.pollers.get(repo)?.forge?.defaultBranch;
    return branch === def || branch === 'main' || branch === 'dev';
  }

  private context(repo?: RepoName): MatchContext {
    const def = repo ? this.pollers.get(repo)?.forge?.defaultBranch : undefined;
    return { protectedBranches: new Set(['main', 'dev', ...(def ? [def] : [])]) };
  }

  private dispatch(events: HelmEvent[]): void {
    if (!events.length) return;
    this.ledger.record(events);
    const subs = Object.values(this.ledger.data.subscriptions);
    // events of different repositories match against different protected branches
    const byRepo = new Map<string, HelmEvent[]>();
    for (const e of events) byRepo.set(e.repo ?? '', [...(byRepo.get(e.repo ?? '') ?? []), e]);
    for (const [repo, batch] of byRepo) {
      const { letters, retired } = route(batch, subs, this.context(repo || undefined), this.now());
      for (const l of letters) this.send(this.ledger.post(l));
      for (const id of retired) this.ledger.unsubscribe(id);
    }
  }

  private send(letter: Letter): void {
    for (const write of this.streams.get(letter.session) ?? []) write({ type: 'letter', letter });
  }

  private changed(): void {
    this.ledgerSaver?.save();
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = undefined;
        const frame: StreamFrame = { type: 'changed', at: this.now() };
        for (const set of this.streams.values()) for (const write of set) write(frame);
        for (const write of this.watchers) write(frame);
      }, 250);
    }
    if (!this.refreshTimer) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        this.refreshViews();
      }, 300);
    }
  }

  // phase changes become work events, and a stalled item raises a decision until it moves again
  private refreshViews(): void {
    const views = this.workViews();
    const seeding = this.phases === undefined;
    const before = this.phases ?? new Map<string, Phase>();
    const next = new Map<string, Phase>();
    const events: HelmEvent[] = [];
    for (const v of views) {
      const key = workKey(v.repo, v.issue);
      next.set(key, v.phase);
      const was = before.get(key);
      const stallKey = `stall:work:${key}`;
      if (v.phase === 'stalled') {
        const raised = this.ledger.raise(stallKey, {
          kind: 'stall',
          repo: v.repo,
          issue: v.issue,
          title: `#${v.issue} has no live agent`,
          body: `${v.title}\nagent ${v.agent ?? 'none'} is ${v.agentStatus ?? 'unknown'}${v.pull ? `, pr #${v.pull.number} is ${v.pull.draft ? 'a draft' : 'open'} with ci ${v.verdict}` : ', no pr'}. Resume it with dispatch, or release it.`,
          blocking: false,
          ...(v.owner ? { from: { session: v.owner } } : {}),
        });
        if (raised) this.announce(raised);
      } else this.ledger.resolveKey(stallKey);
      if (seeding || was === v.phase) continue;
      events.push({
        id: `work:${key}:${v.phase}@${this.now()}`,
        kind: 'work',
        repo: v.repo,
        issue: v.issue,
        at: this.now(),
        tags: ['phase', v.phase],
        text: `${key} ${was ?? 'new'} → ${v.phase}: ${v.title}`,
        detail: [
          [v.agent ? `agent ${v.agent} (${v.agentStatus ?? '?'})` : 'no agent', v.routing ? `${v.routing.model}/${v.routing.effort}` : '', v.pull ? `pr #${v.pull.number}` : '', v.verdict !== 'none' ? `ci ${v.verdict}` : '']
            .filter(Boolean)
            .join(' · '),
          ...(v.report?.note ? [`report: ${v.report.note}`] : []),
        ],
        ...(v.pull ? { url: v.pull.url } : v.issueUrl ? { url: v.issueUrl } : {}),
        ...(v.owner ? { owner: v.owner } : {}),
      });
    }
    this.phases = next;
    this.dispatch(events);
  }

  workViews(): WorkView[] {
    const sessions = new Map(Object.entries(this.ledger.data.sessions));
    const decisions = Object.values(this.ledger.data.decisions);
    return Object.values(this.ledger.data.work)
      .map((w) => viewOf(w, this.pollers.get(w.repo)?.forge, this.local.get(w.repo), sessions, decisions, this.now()))
      .sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '') || a.order - b.order);
  }

  // lite leaves out each repository's forge and local state: what a pane redraws from on every change
  fleet(lite = false): Fleet {
    const d = this.ledger.data;
    const repos: Record<RepoName, RepoView> = {};
    for (const repo of this.watched()) repos[repo] = lite ? { polling: this.repoView(repo).polling } : this.repoView(repo);
    return {
      version: this.version,
      sessions: Object.values(d.sessions).sort((a, b) => b.seenAt - a.seenAt),
      work: this.workViews(),
      decisions: Object.values(d.decisions).sort((a, b) => b.createdAt - a.createdAt),
      subscriptions: Object.values(d.subscriptions),
      repos,
      rates: { ...this.gh.rates },
      at: this.now(),
    };
  }

  repoView(repo: RepoName): RepoView {
    const st = this.polls.get(repo);
    const forge = this.pollers.get(repo)?.forge;
    const local = this.local.get(repo);
    return {
      ...(forge ? { forge } : {}),
      ...(local ? { local } : {}),
      polling: st ? { active: st.active, interval: st.interval, failures: st.failures, ...(st.lastPoll ? { lastPoll: st.lastPoll } : {}), ...(st.lastChange ? { lastChange: st.lastChange } : {}), ...(st.error ? { error: st.error } : {}) } : { active: false, interval: 0, failures: 0 },
    };
  }

  // a repository a caller asks about is polled from now on, and read at once the first time
  async ask(repo: RepoName): Promise<RepoView> {
    this.asked.set(repo, this.now());
    // a cached snapshot from before this daemon started is not an answer
    if (!this.polls.get(repo)?.lastPoll) await this.pollRepo(repo);
    if (!this.local.has(repo)) {
      if (!this.checkouts.size) {
        this.checkouts = await discover(this.config.roots, this.git);
        this.discoveredAt = this.now();
      }
      const checkouts = this.checkouts.get(repo);
      if (checkouts?.length) this.local.set(repo, await scan(repo, checkouts, this.now(), this.git));
    }
    return this.repoView(repo);
  }

  forgeOf(repo: RepoName): ForgeState | undefined {
    return this.pollers.get(repo)?.forge;
  }

  register(b: RegisterBody): Session {
    const s = this.ledger.register(b);
    if (s.repo) this.asked.set(s.repo, this.now());
    return s;
  }

  heartbeat(id: string, agents: AgentRecord[]): Session | undefined {
    return this.ledger.heartbeat(id, agents);
  }

  setRole(id: string, role: SessionRole, repo?: RepoName): Session | undefined {
    return this.ledger.setRole(id, role, repo);
  }

  subscribe(b: SubscribeBody): Subscription {
    const sub = this.ledger.subscribe(b);
    if (sub.repo) void this.ask(sub.repo);
    return sub;
  }

  queue(b: QueueBody): ReturnType<Ledger['queue']> {
    const forge = this.forgeOf(b.repo);
    return this.ledger.queue(b, (n) => forge?.issues.find((i) => i.number === n)?.title);
  }

  claim(b: ClaimBody): ReturnType<Ledger['claim']> {
    const title = this.forgeOf(b.repo)?.issues.find((i) => i.number === b.issue)?.title;
    return this.ledger.claim(b, title);
  }

  report(b: ReportBody): ReturnType<Ledger['report']> {
    const out = this.ledger.report(b);
    for (const d of out.decisions) this.announce(d);
    return out;
  }

  decide(b: DecisionBody): Decision {
    const d = this.ledger.decide(b);
    this.announce(d);
    return d;
  }

  private announce(d: Decision): void {
    const owner = d.from?.session ?? this.ownerOf(d);
    this.dispatch([
      {
        id: `decision:${d.id}:opened`,
        kind: 'decision',
        ...(d.repo ? { repo: d.repo } : {}),
        ...(d.issue !== undefined ? { issue: d.issue } : {}),
        at: this.now(),
        tags: ['decision', d.kind, ...(d.blocking ? ['blocking'] : [])],
        text: `decision ${d.id} ${d.blocking ? 'waiting' : 'for review'} (${d.kind})${d.repo ? ` ${d.repo}${d.issue !== undefined ? `#${d.issue}` : ''}` : ''}: ${d.title}`,
        ...(owner ? { owner } : {}),
      },
    ]);
  }

  private ownerOf(d: Pick<Decision, 'repo' | 'issue'>): string | undefined {
    return d.repo && d.issue !== undefined ? this.ledger.data.work[workKey(d.repo, d.issue)]?.owner : undefined;
  }

  // the answer goes to whoever is waiting on it: the agent that asked, else its session, else the work's owner
  answer(id: string, b: AnswerBody): Answered {
    const d = this.ledger.answer(id, b);
    const recipient = d.kind === 'routing' ? (this.ownerOf(d) ? { session: this.ownerOf(d)! } : undefined) : (d.from ?? (this.ownerOf(d) ? { session: this.ownerOf(d)! } : undefined));
    const lines = [`[helm decision ${d.id} answered by ${b.by}] ${d.title}`];
    if (b.option) lines.push(`choice: ${b.option}`);
    if (b.text) lines.push(b.text);
    if (d.kind === 'routing' && b.option) {
      const tier = this.config.routing.tiers.find((t) => t.name === b.option);
      if (tier && d.repo && d.issue !== undefined) {
        lines.push(`rerouted to ${tier.name} (${tier.model}/${tier.effort}). If an agent is still on ${d.repo}#${d.issue}, stop it, then dispatch the issue again with tier ${tier.name}: the new agent resumes the existing branch and PR.`);
      }
    }
    const live = recipient && this.ledger.live(recipient.session);
    if (recipient && live) this.send(this.ledger.post({ session: recipient.session, ...(recipient.agent ? { agent: recipient.agent } : {}), text: lines.join('\n'), events: [], subs: [] }));
    const owner = recipient?.session;
    this.dispatch([
      {
        id: `decision:${d.id}:answered@${this.now()}`,
        kind: 'decision',
        ...(d.repo ? { repo: d.repo } : {}),
        ...(d.issue !== undefined ? { issue: d.issue } : {}),
        at: this.now(),
        tags: ['answered'],
        text: `decision ${d.id} answered by ${b.by}: ${d.title}${b.option ? ` → ${b.option}` : ''}`,
        ...(owner ? { owner } : {}),
      },
    ]);
    return { decision: d, delivered: Boolean(live) };
  }

  stream(session: string, write: (f: StreamFrame) => void): () => void {
    const set = this.streams.get(session) ?? new Set();
    set.add(write);
    this.streams.set(session, set);
    write({ type: 'hello', version: this.version, protocol: 1 });
    for (const l of this.ledger.pending(session)) write({ type: 'letter', letter: l });
    return () => {
      set.delete(write);
      if (!set.size) this.streams.delete(session);
    };
  }

  watch(write: (f: StreamFrame) => void): () => void {
    this.watchers.add(write);
    return () => this.watchers.delete(write);
  }

  ping(): void {
    const frame: StreamFrame = { type: 'ping', at: this.now() };
    for (const set of this.streams.values()) for (const write of set) write(frame);
    for (const write of this.watchers) write(frame);
  }

  async configFor(repo?: RepoName): Promise<ConfigView> {
    let routing = this.config.routing;
    const checkout = repo ? this.checkouts.get(repo)?.[0] : undefined;
    if (checkout) {
      const raw = await readFile(join(checkout, '.helm', 'config.json'), 'utf8').catch(() => undefined);
      if (raw !== undefined) routing = mergeConfig(this.config, repoLayer(JSON.parse(raw))).routing;
    }
    return { routing, web: `http://127.0.0.1:${this.config.web.port}/` };
  }

  async issue(repo: RepoName, n: number): Promise<IssueDetail> {
    type RestIssue = { number: number; title: string; body: string | null; state: string; html_url: string; labels: { name: string }[]; user: { login: string } | null; pull_request?: unknown };
    type RestComment = { user: { login: string } | null; body: string | null; created_at: string; html_url: string };
    const i = await this.gh.get<RestIssue>(`repos/${repo}/issues/${n}`);
    const comments = await this.gh.get<RestComment[]>(`repos/${repo}/issues/${n}/comments?per_page=100`);
    return {
      repo,
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      pr: i.pull_request !== undefined,
      author: i.user?.login ?? 'ghost',
      labels: i.labels.map((l) => l.name),
      body: i.body ?? '',
      comments: comments.map((c) => ({ author: c.user?.login ?? 'ghost', at: c.created_at, url: c.html_url, body: c.body ?? '' })),
    };
  }

  // a finished job's log is kept on disk, since it never changes; one still running has none to read yet
  async jobLog(repo: RepoName, job: number, opts: { tail?: number; grep?: string; errors?: boolean }): Promise<string> {
    const file = join(this.paths.logs, repo.replace('/', '__'), `${job}.log`);
    let text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) {
      const meta = await this.gh.get<{ status: string }>(`repos/${repo}/actions/jobs/${job}`);
      if (meta.status !== 'completed') throw new Error(`job ${job} is ${meta.status}: github serves a job's log once it completes; its steps are live in the run view`);
      text = await this.gh.text(`repos/${repo}/actions/jobs/${job}/logs`);
      await mkdir(join(this.paths.logs, repo.replace('/', '__')), { recursive: true });
      await writeFile(file, text);
    }
    return trimLog(text, opts);
  }

  async run(repo: RepoName, id: number): Promise<{ run: unknown; jobs: unknown }> {
    const run = await this.gh.get<unknown>(`repos/${repo}/actions/runs/${id}`);
    const jobs = await this.gh.get<unknown>(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`);
    return { run, jobs };
  }

  async persist(): Promise<void> {
    await writeJson(this.paths.ledger, this.ledger.data);
  }
}

// timestamps dropped, then the error lines with what led up to them, a grep, or the tail
export function trimLog(raw: string, opts: { tail?: number; grep?: string; errors?: boolean }): string {
  const lines = raw.split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
  if (opts.grep) {
    const re = new RegExp(opts.grep, 'i');
    return lines.filter((l) => re.test(l)).slice(-(opts.tail ?? LOG_TAIL)).join('\n');
  }
  if (opts.errors) {
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (/##\[error\]|error(\[|:)|FAIL|panicked/i.test(l)) for (let k = Math.max(0, i - 20); k <= Math.min(lines.length - 1, i + 3); k++) keep.add(k);
    });
    if (keep.size) {
      const out: string[] = [];
      let last = -2;
      for (const i of [...keep].sort((a, b) => a - b)) {
        if (i !== last + 1) out.push(`… (line ${i + 1})`);
        out.push(lines[i]!);
        last = i;
      }
      return out.slice(-(opts.tail ?? LOG_TAIL * 2)).join('\n');
    }
  }
  const tail = opts.tail ?? LOG_TAIL;
  return (lines.length > tail ? [`… ${lines.length - tail} earlier lines`, ...lines.slice(-tail)] : lines).join('\n');
}
