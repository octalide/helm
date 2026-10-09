import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDone, verdictOf } from '../core/checks.ts';
import { type Config, DEFAULT_CONFIG, mergeConfig, repoLayer } from '../core/config.ts';
import { isRecord } from '../core/decision.ts';
import type { AnswerBody, Answered, ClaimBody, ConfigView, DecisionBody, EscalateBody, IssueDetail, QueueBody, RegisterBody, ReportBody, StreamFrame, SubscribeBody } from '../core/protocol.ts';
import { PROTOCOL, workKey } from '../core/protocol.ts';
import type { HelmPaths } from '../core/paths.ts';
import type { AgentRecord, Decision, Fleet, ForgeState, HelmEvent, Letter, LocalState, Phase, PollStatus, Pull, RepoName, RepoView, Session, SessionRole, Subscription, TreeNode, WorkView } from '../core/types.ts';
import { route } from './deliver.ts';
import { buildTree } from '../core/tree.ts';
import { hasWorker, selfWorked } from '../core/work.ts';
import { pullFor, viewOf } from './derive.ts';
import { verdictEvent } from './events.ts';
import { epicEvents, rootsOf } from './epics.ts';
import type { GitHub } from './github.ts';
import { emptyLedger, Ledger, type LedgerData } from './ledger.ts';
import { discover, type Git, git as realGit, scan } from './local.ts';
import { readJson, Saver, writeJson } from './persist.ts';
import { leftovers, type ProcTable, procfs, still } from './procs.ts';
import { emptyCache, type RepoCache, RepoPoller } from './poller.ts';
import { ended, heldKey, expired, type MatchContext } from './watch.ts';

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
  procs?: ProcTable;
  // told of every config applied after start, for what lives outside the daemon such as the web listener
  onConfig?: (next: Config, prev: Config) => void;
};

// the machine's config: the defaults under ~/.config/helm/config.json
export async function readConfig(paths: HelmPaths): Promise<Config> {
  const file = join(paths.config, 'config.json');
  const raw = await readJson(file);
  try {
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

// again: asked for while it ran, so it runs once more as soon as it finishes
type Poll = PollStatus & { due: number; running: boolean; again?: boolean };

// how many repositories poll at once
const POLL_CONCURRENCY = 3;
// a repository asked about by a tool or the page stays polled this long after the last ask
const LITE_DONE_MS = 24 * 3600_000;
// runs a lite view carries: those in flight and those finished this recently, newest first
const LITE_RUNS_MS = 30 * 60_000;
const LITE_RUNS = 8;
const ASKED_MS = 30 * 60_000;
// checkouts are searched for again this often
const DISCOVER_MS = 10 * 60_000;
// below this many calls left in a pool, every poll waits for the window to reset
const RATE_FLOOR = 150;
const LOG_TAIL = 200;

const SHA = /^[0-9a-f]{7,40}$/i;
// a commit id and one of its abbreviations name the same commit
const sameSha = (a: string, b: string): boolean => a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase());

// one letter's addressee: a session's main loop, or one agent of it
type Recipient = { session: string; agent?: string };

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
  private readonly procs: ProcTable;
  private readonly loops: boolean;
  private readonly onConfig: (next: Config, prev: Config) => void;
  private readonly pollers = new Map<RepoName, RepoPoller>();
  private readonly savers = new Map<RepoName, Saver>();
  private readonly local = new Map<RepoName, LocalState>();
  private checkouts = new Map<RepoName, string[]>();
  private discoveredAt = 0;
  private readonly polls = new Map<RepoName, Poll>();
  private readonly asked = new Map<RepoName, number>();
  private phases?: Map<string, Phase>;
  // root epic -> its rollup when last looked at
  private rollups?: Map<string, string>;
  private readonly streams = new Map<string, Set<(f: StreamFrame) => void>>();
  private readonly watchers = new Set<(f: StreamFrame) => void>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private ledgerSaver!: Saver;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private scanning = false;
  private localTimer?: ReturnType<typeof setInterval>;
  private configWatcher?: FSWatcher;
  private configTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: DaemonDeps) {
    this.paths = deps.paths;
    this.config = deps.config;
    this.gh = deps.gh;
    this.version = deps.version;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.git = deps.git ?? realGit;
    this.procs = deps.procs ?? procfs();
    this.loops = deps.loops ?? true;
    this.onConfig = deps.onConfig ?? (() => {});
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
    this.armLocal();
    this.timers.push(setInterval(() => this.sweep(), 15_000));
    void this.scanLocal();
    await this.watchConfig();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    clearInterval(this.localTimer);
    clearTimeout(this.configTimer);
    this.configWatcher?.close();
    clearTimeout(this.notifyTimer);
    clearTimeout(this.refreshTimer);
    await this.ledgerSaver?.flush();
    await Promise.all([...this.savers.values()].map((s) => s.flush()));
  }

  private armLocal(): void {
    clearInterval(this.localTimer);
    if (this.loops) this.localTimer = setInterval(() => void this.scanLocal(), this.config.poll.local * 1000);
  }

  // the directory, not the file: an editor that saves by renaming over the file would leave a file watch on the old one
  private async watchConfig(): Promise<void> {
    await mkdir(this.paths.config, { recursive: true });
    this.configWatcher = watch(this.paths.config, (_, name) => {
      if (name && name !== 'config.json') return;
      clearTimeout(this.configTimer);
      this.configTimer = setTimeout(() => void this.reloadConfig(), 200);
    });
    this.configWatcher.on('error', (e) => this.log(`config watch failed: ${e.message}`));
  }

  // the config file read again and applied; one that fails to parse or check is logged and the running config kept
  async reloadConfig(): Promise<void> {
    let next: Config;
    try {
      next = await readConfig(this.paths);
    } catch (error) {
      this.log(`config not applied, keeping the running one: ${(error as Error).message}`);
      return;
    }
    const prev = this.config;
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.config = next;
    if (next.poll.local !== prev.poll.local) this.armLocal();
    if (JSON.stringify(next.roots) !== JSON.stringify(prev.roots)) {
      this.discoveredAt = 0;
      if (this.loops) void this.scanLocal();
    }
    this.onConfig(next, prev);
    this.log('config applied');
    this.changed();
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
    if (Object.values(d.work).some((w) => w.repo === repo && !w.finished && hasWorker(w))) return true;
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
    if (st.running) {
      st.again = true;
      return;
    }
    st.running = true;
    try {
      const p = await this.poller(repo);
      const { changed, events } = await p.poll(this.now(), force);
      this.savers.get(repo)?.save();
      st.failures = 0;
      delete st.error;
      st.lastPoll = this.now();
      if (changed) st.lastChange = st.lastPoll;
      this.ledger.reviewHeld(repo, (n) => {
        const pull = p.forge?.pulls.find((x) => x.number === n && x.state === 'open');
        const verdict = pull ? verdictOf(pull.checks) : 'none';
        return pull && (verdict === 'success' || verdict === 'failure') ? pull.sha : undefined;
      });
      if (events.length) this.handle(repo, events, await this.heldHeads(repo, events));
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
    if (st.again) {
      delete st.again;
      await this.pollRepo(repo, force);
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
      await this.recheckLeftovers();
      if (moved) this.changed();
    } catch (error) {
      this.log(`local scan failed: ${(error as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private sweep(): void {
    const gone = this.ledger.sweep(this.config.poll.goneSeconds * 1000);
    for (const s of gone) {
      this.log(`session ${s.id} went quiet`);
      this.orphan(s.id);
    }
    const now = this.now();
    for (const s of Object.values(this.ledger.data.subscriptions)) {
      if (expired(s, now) || ended(s, s.repo ? this.pollers.get(s.repo)?.forge : undefined)) this.ledger.unsubscribe(s.id);
    }
    this.refreshViews();
  }

  // what an event means for the ledger beyond its delivery: finished work, and conditions raised or cleared
  private handle(repo: RepoName, events: HelmEvent[], held?: ReadonlySet<string>): void {
    const forge = this.pollers.get(repo)?.forge;
    for (const e of events) {
      // an issue closed by its merged pr finished as merged, whichever of the two events comes first
      if (e.kind === 'issue' && e.issue !== undefined && e.tags.includes('closed')) this.ledger.finish(repo, e.issue, forge && pullFor(e.issue, forge.pulls)?.state === 'merged' ? 'merged' : 'closed');
      if (e.kind === 'pr' && e.pr !== undefined && e.tags.includes('merged')) {
        const pull = forge?.pulls.find((p) => p.number === e.pr);
        for (const w of Object.values(this.ledger.data.work)) {
          if (w.repo === repo && !w.finished && pull && pullFor(w.issue, [pull])) this.ledger.finish(repo, w.issue, 'merged');
        }
      }
      if (e.kind === 'ci' && e.pr !== undefined) {
        if (e.tags.includes('stalled')) {
          const raised = this.ledger.raise(`stall:ci:${repo}#${e.pr}`, `head ${e.sha ?? ''}`, { kind: 'stall', repo, title: `CI stalled on pr #${e.pr}`, body: [e.text, ...(e.detail ?? []), e.url ?? ''].join('\n'), blocking: false, ...this.prIssue(repo, e.pr) });
          if (raised) this.announce(raised);
        }
        if (e.tags.includes('settled')) this.ledger.resolveKey(`stall:ci:${repo}#${e.pr}`);
      }
      if (e.kind === 'ci' && e.run !== undefined && e.branch && this.lasting(repo, e.branch)) {
        const run = forge?.runs.find((r) => r.id === e.run);
        const key = `failure:${repo}:${run?.workflow ?? ''}:${e.branch}`;
        if (e.tags.includes('failure')) {
          const raised = this.ledger.raise(key, `run ${e.run}`, { kind: 'failure', repo, title: `${run?.workflow ?? 'CI'} failing on ${e.branch}`, body: [e.text, e.url ?? ''].join('\n'), blocking: false });
          if (raised) this.announce(raised);
        }
        if (e.tags.includes('success')) this.ledger.resolveKey(key);
      }
    }
    this.dispatch(events, held ? { held } : {});
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

  private context(repo?: RepoName, held?: ReadonlySet<string>): MatchContext {
    const def = repo ? this.pollers.get(repo)?.forge?.defaultBranch : undefined;
    return { protectedBranches: new Set(['main', 'dev', ...(def ? [def] : [])]), ...(held ? { held } : {}) };
  }

  // events to every subscription that takes them; to only the given ones for a catch-up, which the log already holds;
  // past one recipient a direct letter already reached
  private dispatch(events: HelmEvent[], opts: { only?: Subscription[]; except?: Recipient; held?: ReadonlySet<string> } = {}): void {
    if (!events.length) return;
    if (!opts.only) this.ledger.record(events);
    const all = opts.only ?? Object.values(this.ledger.data.subscriptions);
    const except = opts.except;
    const subs = except ? all.filter((s) => !(s.session === except.session && (s.agent ?? '') === (except.agent ?? ''))) : all;
    // events of different repositories match against different protected branches
    const byRepo = new Map<string, HelmEvent[]>();
    for (const e of events) byRepo.set(e.repo ?? '', [...(byRepo.get(e.repo ?? '') ?? []), e]);
    for (const [repo, batch] of byRepo) {
      const { letters, retired } = route(batch, subs, this.context(repo || undefined, opts.held), this.now());
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
      this.ledger.phase(v.repo, v.issue, v.phase);
      // done by what the forge says, though no close or merge event reached helm: a poll that only seeded saw it
      if (v.phase === 'done' && !v.finished) this.finishLate(v);
      const was = before.get(key);
      const stallKey = `stall:work:${key}`;
      if (v.phase === 'stalled') {
        const raised = this.ledger.raise(stallKey, stallCondition(v), {
          kind: 'stall',
          repo: v.repo,
          issue: v.issue,
          title: `#${v.issue} has no live agent`,
          body: `${v.title}\nagent ${v.agent ?? 'none'} is ${v.agentStatus ?? 'unknown'}${v.pull ? `, pr #${v.pull.number} is ${v.pull.draft ? 'a draft' : 'open'} with ci ${v.verdict}` : ', no pr'}. Resume it with dispatch, or release it.`,
          blocking: false,
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
        phase: { from: was ?? 'new', to: v.phase, title: v.title },
        detail: [
          [v.agent ? `agent ${v.agent} (${v.agentStatus ?? '?'})` : selfWorked(v) ? 'worked by its session' : 'no agent', v.routing ? `${v.routing.model}/${v.routing.effort}` : '', v.pull ? `pr #${v.pull.number}` : '', v.verdict !== 'none' ? `ci ${v.verdict}` : '']
            .filter(Boolean)
            .join(' · '),
          ...(v.report?.note ? [`report: ${v.report.note}`] : []),
        ],
        ...(v.pull ? { url: v.pull.url } : v.issueUrl ? { url: v.issueUrl } : {}),
        ...(v.owner ? { owner: v.owner } : {}),
      });
    }
    this.phases = next;
    const tree = this.tree(views);
    const roots = rootsOf(tree);
    for (const e of events) {
      const root = roots.get(workKey(e.repo!, e.issue!));
      if (root) e.epic = root;
    }
    const epics = epicEvents(tree, this.rollups, events, this.now());
    this.rollups = epics.seen;
    this.dispatch([...events, ...epics.events]);
  }

  private tree(work: readonly WorkView[]): TreeNode[] {
    return buildTree([...this.pollers.values()].flatMap((p) => (p.forge ? [p.forge] : [])), work);
  }

  private finishLate(v: WorkView): void {
    const forge = this.pollers.get(v.repo)?.forge;
    const pull = v.pull ? forge?.pulls.find((p) => p.number === v.pull!.number) : undefined;
    const closed = pull?.state === 'merged' ? pull.closedAt : forge?.issues.find((i) => i.number === v.issue)?.closedAt;
    this.ledger.finish(v.repo, v.issue, pull?.state === 'merged' ? 'merged' : 'closed', closed ? Date.parse(closed) : this.now());
  }

  workViews(): WorkView[] {
    const sessions = new Map(Object.entries(this.ledger.data.sessions));
    const decisions = Object.values(this.ledger.data.decisions);
    const subscriptions = Object.values(this.ledger.data.subscriptions);
    return Object.values(this.ledger.data.work)
      .map((w) => viewOf(w, this.pollers.get(w.repo)?.forge, this.local.get(w.repo), sessions, decisions, this.now(), subscriptions))
      .sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '') || a.order - b.order);
  }

  // lite leaves out each repository's forge and local state: what a pane redraws from on every change
  fleet(lite = false): Fleet {
    const d = this.ledger.data;
    const repos: Record<RepoName, RepoView> = {};
    for (const repo of this.watched()) repos[repo] = lite ? this.liteView(repo) : this.repoView(repo);
    const work = this.workViews();
    return {
      version: this.version,
      sessions: Object.values(d.sessions).sort((a, b) => b.seenAt - a.seenAt),
      // a pane has no use for work finished before today
      work: lite ? work.filter((w) => !w.finished || this.now() - w.finished.at < LITE_DONE_MS) : work,
      tree: this.tree(work),
      decisions: Object.values(d.decisions).sort((a, b) => b.createdAt - a.createdAt),
      subscriptions: Object.values(d.subscriptions),
      repos,
      ...(lite ? {} : { events: d.events.slice(-150) }),
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

  private liteView(repo: RepoName): RepoView {
    const now = this.now();
    const runs = (this.pollers.get(repo)?.forge?.runs ?? []).filter((r) => !isDone(r.state) || now - Date.parse(r.updatedAt) < LITE_RUNS_MS).slice(0, LITE_RUNS);
    return { polling: this.repoView(repo).polling, runs };
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
    const before = new Map((this.ledger.data.sessions[id]?.agents ?? []).map((a) => [a.id, a.status]));
    const s = this.ledger.heartbeat(id, agents);
    if (!s) return undefined;
    // an agent whose loop stopped since the last beat, or that came and went between two
    for (const a of agents) {
      const was = before.get(a.id);
      if (!LOOPING.has(a.status) && (was === undefined || LOOPING.has(was))) void this.agentEnded(id, a.id);
    }
    for (const [agent, was] of before) if (LOOPING.has(was) && !agents.some((a) => a.id === agent)) void this.agentEnded(id, agent);
    return s;
  }

  // a leftover that has exited, or moved out of the worktree, is no longer reported
  async recheckLeftovers(): Promise<void> {
    for (const v of this.workViews()) {
      if (!v.leftovers?.length) continue;
      this.ledger.leftovers(v.repo, v.issue, await still(v.leftovers, v.worktree?.path, this.procs));
    }
  }

  // what an ended agent left running in its work's worktree goes on the work item, and to its owner when there is any
  async agentEnded(session: string, agent: string): Promise<void> {
    for (const v of this.workViews()) {
      if (v.owner !== session || v.agent !== agent || v.finished || !v.worktree || v.worktree.main) continue;
      const found = await leftovers(v.worktree.path, this.procs).catch((error: Error) => {
        this.log(`process scan of ${v.worktree!.path} failed: ${error.message}`);
        return [];
      });
      this.ledger.leftovers(v.repo, v.issue, found);
      if (!found.length) continue;
      const key = workKey(v.repo, v.issue);
      this.dispatch([
        {
          id: `work:${key}:leftovers@${this.now()}`,
          kind: 'work',
          repo: v.repo,
          issue: v.issue,
          at: this.now(),
          tags: ['leftovers'],
          text: `${key} agent ${agent} ended and left ${found.length} process${found.length === 1 ? '' : 'es'} running in ${v.worktree.path}: ${v.title}`,
          detail: [...found.map((p) => `pid ${p.pid}: ${p.command.slice(0, 200)}`), 'helm kills nothing: whoever owns the work decides'],
          ...(v.pull ? { url: v.pull.url } : v.issueUrl ? { url: v.issueUrl } : {}),
          owner: session,
        },
      ]);
    }
  }

  setRole(id: string, role: SessionRole, repo?: RepoName): Session | undefined {
    return this.ledger.setRole(id, role, repo);
  }

  // a new subscription polls its repository, and one on a pr whose head ci has already settled hears that verdict
  // now, alone: the event that announced it fired before the subscription existed. a pr subscription waits on the
  // head its caller names, else on the branch as this machine last pushed it
  async subscribe(b: SubscribeBody): Promise<Subscription> {
    if (b.sha !== undefined && !SHA.test(b.sha)) throw new Error(`sha ${b.sha} is not a commit id of 7 to 40 hex digits`);
    if (b.repo) await this.ask(b.repo).catch(() => undefined);
    const scope = b.scope;
    const pull = b.repo && scope.kind === 'pr' ? this.forgeOf(b.repo)?.pulls.find((p) => p.number === scope.number && p.state === 'open') : undefined;
    const guess = !b.sha && b.repo && pull && !pull.fork ? await this.pushedHead(b.repo, pull.head) : undefined;
    const sub = this.ledger.subscribe(b, guess);
    if (sub.repo && pull) await this.catchUp(sub, sub.repo, pull);
    return sub;
  }

  private async catchUp(sub: Subscription, repo: RepoName, pull: Pull): Promise<void> {
    if (sub.ci === 'none') return;
    const verdict = verdictOf(pull.checks);
    if (verdict !== 'success' && verdict !== 'failure') return;
    // right after a push the forge can still show the old head: its verdict is not the one the subscriber waits on,
    // and the live verdict comes once ci settles on the new head
    if (await this.holds(repo, sub, pull.sha, pull.number)) return this.ledger.holdBack(sub.id, pull.sha);
    this.dispatch([verdictEvent(repo, pull, verdict, this.now())], { only: [sub] });
  }

  // the branch's head as this machine last pushed or fetched it, the newest across the repository's checkouts
  private async pushedHead(repo: RepoName, branch: string): Promise<string | undefined> {
    const ref = `refs/remotes/origin/${branch}`;
    let best: { sha: string; at: number } | undefined;
    for (const checkout of this.checkouts.get(repo) ?? []) {
      const out = await this.git(checkout, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', ref]).catch(() => '');
      const [, sha, at] = out.split('\n').find((l) => l.startsWith(`${ref}\t`))?.split('\t') ?? [];
      if (sha && (!best || Number(at) > best.at)) best = { sha, at: Number(at) };
    }
    return best?.sha;
  }

  // whether ci on sha is not the verdict a subscription waits on. a named head takes only itself and what descends
  // from it, so a pre-rebase head is held back too. a guessed head holds back only what it strictly descends from,
  // since the guess can itself be the stale side. either way a pair helm cannot judge delivers
  private async holds(repo: RepoName, sub: Subscription, sha: string, pr: number): Promise<boolean> {
    if (!sub.head || sameSha(sha, sub.head)) return false;
    return sub.named ? (await this.descends(repo, pr, sha, sub.head)) === false : (await this.descends(repo, pr, sub.head, sha)) === true;
  }

  // whether head descends from base, by a checkout that has both commits. when none has them, the pr's head is
  // fetched into one, since a head pushed from another machine or a fork is in no checkout here; undefined when
  // still missing
  private async descends(repo: RepoName, pr: number, head: string, base: string): Promise<boolean | undefined> {
    const checkouts = this.checkouts.get(repo) ?? [];
    const has = async (checkout: string) => {
      for (const sha of [head, base]) if (!(await this.git(checkout, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false))) return false;
      return true;
    };
    const judge = (checkout: string) => this.git(checkout, ['merge-base', '--is-ancestor', base, head]).then(() => true, () => false);
    for (const checkout of checkouts) if (await has(checkout)) return judge(checkout);
    const into = checkouts[0];
    if (!into) return undefined;
    await this.git(into, ['fetch', '--quiet', 'origin', `pull/${pr}/head`]).catch((error: Error) => this.log(`${repo} fetch of pr #${pr} failed: ${error.message}`));
    return (await has(into)) ? judge(into) : undefined;
  }

  // the ci events of a poll that are on a head some pr subscription does not wait on
  private async heldHeads(repo: RepoName, events: HelmEvent[]): Promise<Set<string>> {
    const out = new Set<string>();
    const subs = Object.values(this.ledger.data.subscriptions).filter((s) => s.repo === repo && s.head);
    const pulls = this.forgeOf(repo)?.pulls ?? [];
    for (const e of events) {
      if (e.kind !== 'ci' || e.pr === undefined || !e.sha) continue;
      const pull = pulls.find((p) => p.number === e.pr);
      for (const s of subs) {
        if (s.scope.kind !== 'pr' || s.scope.number !== e.pr || !(await this.holds(repo, s, e.sha, e.pr))) continue;
        out.add(heldKey(s.id, e.sha));
        if (e.tags.includes('settled') && pull?.state === 'open' && pull.sha === e.sha) this.ledger.holdBack(s.id, e.sha);
      }
    }
    return out;
  }

  queue(b: QueueBody): ReturnType<Ledger['queue']> {
    const forge = this.forgeOf(b.repo);
    return this.ledger.queue(b, (n) => forge?.issues.find((i) => i.number === n)?.title);
  }

  claim(b: ClaimBody): ReturnType<Ledger['claim']> {
    const title = this.forgeOf(b.repo)?.issues.find((i) => i.number === b.issue)?.title ?? b.title;
    return this.ledger.claim(b, title);
  }

  // an agent reports right after it moved the forge (opened or readied a pr, pushed): reading its repository now
  // keeps the derived phase from lagging what the agent did until the next poll
  report(b: ReportBody): ReturnType<Ledger['report']> {
    const out = this.ledger.report(b);
    for (const d of out.decisions) this.announce(d);
    void this.pollRepo(b.repo);
    return out;
  }

  decide(b: DecisionBody): Decision {
    const d = this.ledger.decide(b);
    this.announce(d);
    return d;
  }

  // only what is the person's carries the decision tag the fleet hears; a record or a session's own decision is in the
  // log for whoever looks
  private announce(d: Decision): void {
    const owner = d.from?.session ?? this.ownerOf(d);
    const where = d.repo ? ` ${d.repo}${d.issue !== undefined ? `#${d.issue}` : ''}` : '';
    const text = isRecord(d)
      ? `${d.kind} ${d.id} recorded for review${where}: ${d.title}`
      : `decision ${d.id} ${d.blocking ? 'waiting' : 'open'} for ${d.to === 'person' ? 'the person' : `session ${d.session}`} (${d.kind})${where}: ${d.title}`;
    this.dispatch([
      {
        id: `decision:${d.id}:opened`,
        kind: 'decision',
        ...(d.repo ? { repo: d.repo } : {}),
        ...(d.issue !== undefined ? { issue: d.issue } : {}),
        at: this.now(),
        tags: [isRecord(d) ? 'record' : d.to === 'person' ? 'decision' : 'session', d.kind, ...(d.blocking ? ['blocking'] : [])],
        text,
        ...(owner ? { owner } : {}),
      },
    ]);
  }

  escalate(id: string, b: EscalateBody): Decision {
    const was = this.ledger.data.decisions[id]?.session;
    const d = this.ledger.escalate(id, b.by, b.note);
    this.escalated(d, was);
    return d;
  }

  endSession(id: string): void {
    this.ledger.endSession(id);
    this.orphan(id);
  }

  // a session gone with decisions addressed to it leaves them to the person
  private orphan(session: string): void {
    for (const d of this.ledger.orphaned(session)) this.escalated(d, session);
  }

  private escalated(d: Decision, from: string | undefined): void {
    const where = d.repo ? ` ${d.repo}${d.issue !== undefined ? `#${d.issue}` : ''}` : '';
    this.dispatch([
      {
        id: `decision:${d.id}:escalated`,
        kind: 'decision',
        ...(d.repo ? { repo: d.repo } : {}),
        ...(d.issue !== undefined ? { issue: d.issue } : {}),
        at: this.now(),
        tags: ['decision', 'escalated', d.kind, ...(d.blocking ? ['blocking'] : [])],
        text: `decision ${d.id} escalated to the person by ${d.escalated?.by ?? 'helm'} (${d.kind})${where}: ${d.title}`,
        ...(d.escalated?.note ? { detail: [d.escalated.note] } : {}),
        ...(from ? { owner: from } : {}),
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
    if (recipient && live) this.send(this.ledger.post({ session: recipient.session, ...(recipient.agent ? { agent: recipient.agent } : {}), text: lines.join('\n'), parts: [{ lines }], events: [], subs: [] }));
    const owner = recipient?.session;
    const event: HelmEvent = {
      id: `decision:${d.id}:answered@${this.now()}`,
      kind: 'decision',
      ...(d.repo ? { repo: d.repo } : {}),
      ...(d.issue !== undefined ? { issue: d.issue } : {}),
      at: this.now(),
      tags: ['answered'],
      text: `decision ${d.id} answered by ${b.by}: ${d.title}${b.option ? ` → ${b.option}` : ''}`,
      ...(owner ? { owner } : {}),
    };
    // the recipient has the answer already; the event is for everyone else watching
    this.dispatch([event], live && recipient ? { except: recipient } : {});
    return { decision: d, delivered: Boolean(live) };
  }

  stream(session: string, write: (f: StreamFrame) => void): () => void {
    const set = this.streams.get(session) ?? new Set();
    set.add(write);
    this.streams.set(session, set);
    write({ type: 'hello', version: this.version, protocol: PROTOCOL });
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

// the engine statuses of an agent whose loop is still going
const LOOPING: ReadonlySet<string> = new Set(['pending', 'running', 'waiting']);

// what a stall stands for: the agent that left it and where its pr was, so a new head, agent or pr state is news
function stallCondition(v: WorkView): string {
  const pr = v.pull ? `pr #${v.pull.number} @${v.pull.sha} ${v.pull.draft ? 'draft' : `ci ${v.verdict}`}` : 'no pr';
  return `agent ${v.agent ?? 'none'} · ${pr}`;
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
