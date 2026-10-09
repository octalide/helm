import type { ClaimBody, DecisionBody, QueueBody, RegisterBody, ReportBody, SubscribeBody } from '../core/protocol.ts';
import { isOpen } from '../core/decision.ts';
import { workKey } from '../core/protocol.ts';
import { inherited, selfWorked } from '../core/work.ts';
import type { AdoptionRecord, AgentRecord, Answer, Audience, Decision, HelmEvent, Leftover, Letter, Phase, RepoName, Session, SessionRole, Subscription, Work } from '../core/types.ts';

// bumped when the stored shape changes; an older file is migrated or refused, never read as this one
export const LEDGER_VERSION = 4;

// an issue that opened while helm watched its repository, held until a session owns it, it closes, or the fleet hears
// that nobody owns it. alone: no live repo session was in its repository when it opened
export type UnownedIssue = { repo: RepoName; issue: number; openedAt: number; alone: boolean; delivered?: number };

export type LedgerData = {
  version: number;
  counters: { sub: number; decision: number; letter: number };
  sessions: Record<string, Session>;
  work: Record<string, Work>;
  decisions: Record<string, Decision>;
  subscriptions: Record<string, Subscription>;
  letters: Record<string, Letter>;
  // the newest events, for the web page's activity feed
  events: HelmEvent[];
  unowned: Record<string, UnownedIssue>;
};

// an older file brought up to this shape, in place
export function migrate(data: LedgerData): LedgerData {
  if (data.version === 1) {
    // version 1 addressed nothing: every decision in it was in the person's inbox, and stays there
    for (const d of Object.values(data.decisions)) d.to ??= 'person';
    data.version = 2;
  }
  if (data.version === 2) {
    repairRoles(data);
    recordAdoptions(data);
    data.version = 3;
  }
  if (data.version === 3) {
    data.unowned = {};
    data.version = 4;
  }
  return data;
}

const roleSub = (x: Subscription, kind: 'work' | 'fleet') => x.agent === undefined && x.scope.kind === kind;
const subOrder = (id: string) => Number(id.slice(1));

// version 2 let a register's default role overwrite the stored one. a coordinator overwritten so kept the fleet
// subscription its own register made, older than the work subscription the overwrite added: it is a coordinator again
function repairRoles(data: LedgerData): void {
  const subs = Object.values(data.subscriptions);
  for (const s of Object.values(data.sessions)) {
    if (s.role !== 'repo') continue;
    const fleet = subs.find((x) => x.session === s.id && roleSub(x, 'fleet'));
    const work = subs.filter((x) => x.session === s.id && roleSub(x, 'work'));
    if (!fleet || !work.length || work.some((x) => subOrder(x.id) < subOrder(fleet.id))) continue;
    s.role = 'coordinator';
    for (const x of work) delete data.subscriptions[x.id];
  }
}

// version 2 recorded an adoption only on each work item it moved, and what else it moved only in its announcement. the
// record each holder needs to give it back is rebuilt from both, as far as the event log still holds the announcement
function recordAdoptions(data: LedgerData): void {
  const listed = (session: string, head: string): string[] =>
    data.events
      .filter((e) => e.kind === 'work' && e.owner === session && e.tags.includes('adopted'))
      .flatMap((e) => (e.detail ?? []).filter((l) => l.startsWith(head)).flatMap((l) => l.slice(head.length).split(/,? /)))
      .map((x) => x.trim())
      .filter((x) => /^[sd]\d+$/.test(x));
  for (const s of Object.values(data.sessions)) {
    const work = Object.values(data.work).filter((w) => w.owner === s.id && w.adopted !== undefined && current(w, w.adopted.agent, w.adopted.at));
    if (!work.length || !s.repo) continue;
    const from = work[0]!.adopted!.from;
    const record: AdoptionRecord = {
      at: Math.min(...work.map((w) => w.adopted!.at)),
      repo: s.repo,
      work: work.map((w) => ({ key: workKey(w.repo, w.issue), ...(w.agent ? { agent: w.agent } : {}), was: { owner: w.adopted!.from, order: w.order } })),
      subscriptions: listed(s.id, "subscriptions now this session's: ")
        .map((id) => data.subscriptions[id])
        .filter((x): x is Subscription => x !== undefined && x.session === s.id)
        .map((x) => ({ id: x.id, ...(x.agent ? { agent: x.agent } : {}), was: from })),
      decisions: listed(s.id, 'decisions now addressed to this session: ')
        .map((id) => data.decisions[id])
        .filter((d): d is Decision => d !== undefined && isOpen(d) && d.to === 'session' && d.session === s.id)
        .map((d) => {
          const w = d.repo && d.issue !== undefined ? data.work[workKey(d.repo, d.issue)] : undefined;
          return { id: d.id, was: { to: 'session' as const, session: w?.adopted?.from ?? from } };
        }),
    };
    s.adoptions = [record];
  }
}

// whether adopted work is still as its adoption left it: the same owner, the agent it came with, and no report since
function current(w: Work, agent: string | undefined, at: number): boolean {
  return !w.finished && w.agent === agent && !(w.report && w.report.at > at);
}

export const emptyLedger = (): LedgerData => ({
  version: LEDGER_VERSION,
  counters: { sub: 0, decision: 0, letter: 0 },
  sessions: {},
  work: {},
  decisions: {},
  subscriptions: {},
  letters: {},
  events: [],
  unowned: {},
});

const EVENT_LOG = 300;
// answered, dismissed and resolved decisions are kept this long for the record, then dropped
const DECISION_KEEP_MS = 7 * 24 * 3600_000;
// finished work stays visible this long
const WORK_KEEP_MS = 30 * 24 * 3600_000;
// phase changes kept per work item
const HISTORY_KEEP = 60;
// a session gone this long is forgotten, with its subscriptions and letters
const SESSION_KEEP_MS = 7 * 24 * 3600_000;

// what a session took over from the gone sessions it succeeds: their unfinished work in backlog order, their
// subscriptions, and the open decisions now addressed to it
export type Adoption = { session: string; from: string[]; work: Work[]; subscriptions: string[]; decisions: Decision[] };

// what a session gave back of what it adopted and had not acted on, and the sessions it went back to
export type GiveBack = { session: string; to: string[]; work: Work[]; subscriptions: string[]; decisions: Decision[] };

export class ClaimError extends Error {
  owner: string;
  constructor(message: string, owner: string) {
    super(message);
    this.owner = owner;
  }
}

// who owns what on this machine. every write goes through here and marks the ledger dirty; nothing else holds state
// a restart needs
export class Ledger {
  data: LedgerData;
  private readonly now: () => number;
  private readonly changed: () => void;

  constructor(data: LedgerData, now: () => number, changed: () => void = () => {}) {
    migrate(data);
    if (data.version !== LEDGER_VERSION) throw new Error(`ledger version ${data.version} is not ${LEDGER_VERSION}`);
    this.data = data;
    this.now = now;
    this.changed = changed;
  }

  // a role asked for wins; otherwise a known session keeps its own, and a new one goes on with the role of the session
  // it goes on from, or defaults by its checkout. a role from a mod before protocol 3 is its guess, a default only
  register(b: RegisterBody): Session {
    const now = this.now();
    const was = this.data.sessions[b.id];
    const prev = !was && b.from !== undefined && b.from !== b.id ? this.data.sessions[b.from] : undefined;
    const asked = (b.protocol ?? 0) >= 3 ? b.role : undefined;
    const guess = (b.protocol ?? 0) >= 3 ? undefined : b.role;
    const repo = was ? (was.repo ?? b.repo) : (prev?.repo ?? b.repo);
    const role: SessionRole = asked ?? was?.role ?? prev?.role ?? guess ?? (repo ? 'repo' : 'other');
    const s: Session = {
      id: b.id,
      role,
      cwd: b.cwd,
      agents: was?.agents ?? [],
      startedAt: was?.startedAt ?? now,
      seenAt: now,
      ...(repo ? { repo } : {}),
      ...((b.title ?? was?.title) ? { title: b.title ?? was?.title } : {}),
      ...(was?.adoptions ? { adoptions: was.adoptions } : {}),
    };
    this.data.sessions[b.id] = s;
    this.roleSubscription(s);
    this.changed();
    return s;
  }

  heartbeat(id: string, agents: AgentRecord[]): Session | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    const before = JSON.stringify(s.agents) + String(s.gone);
    s.agents = agents;
    s.seenAt = this.now();
    delete s.gone;
    if (JSON.stringify(s.agents) + String(s.gone) !== before) this.changed();
    return s;
  }

  setRole(id: string, role: SessionRole, repo?: string): Session | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    s.role = role;
    if (repo) s.repo = repo;
    this.roleSubscription(s);
    this.changed();
    return s;
  }

  endSession(id: string): void {
    const s = this.data.sessions[id];
    if (!s) return;
    s.gone = true;
    this.changed();
  }

  // a repo session hears its own work and a coordinator the fleet, unasked: the subscription is listed and removable,
  // and the other role's goes when the role changes
  private roleSubscription(s: Session): void {
    const kind = s.role === 'coordinator' ? 'fleet' : s.role === 'repo' ? 'work' : undefined;
    let has = false;
    for (const x of Object.values(this.data.subscriptions)) {
      if (x.session !== s.id || x.agent !== undefined || (x.scope.kind !== 'work' && x.scope.kind !== 'fleet')) continue;
      if (x.scope.kind === kind) has = true;
      else delete this.data.subscriptions[x.id];
    }
    if (kind && !has) this.subscribe({ session: s.id, scope: { kind } });
  }

  // guess: a pr subscription's head when the caller named none
  subscribe(b: SubscribeBody, guess?: string): Subscription {
    const spans = b.scope.kind === 'work' || b.scope.kind === 'fleet';
    if (!spans && !b.repo) throw new Error(`a ${b.scope.kind} subscription names its repository`);
    if (b.until !== undefined && b.ci === 'none' && b.until === 'settled') throw new Error('until settled needs ci other than none');
    const id = `s${++this.data.counters.sub}`;
    const sub: Subscription = {
      id,
      scope: b.scope,
      ci: b.ci ?? (b.scope.kind === 'pr' || b.scope.kind === 'branch' || b.scope.kind === 'run' || b.scope.kind === 'tag' ? 'settled' : 'failures'),
      bots: b.bots ?? false,
      session: b.session,
      createdAt: this.now(),
      ...(spans ? {} : { repo: b.repo }),
      ...(b.tags ? { tags: b.tags } : {}),
      ...(b.until !== undefined ? { until: b.until } : {}),
      ...(b.scope.kind === 'pr' && b.sha ? { head: b.sha, named: true } : b.scope.kind === 'pr' && guess ? { head: guess } : {}),
      ...(b.agent ? { agent: b.agent } : {}),
    };
    this.data.subscriptions[id] = sub;
    this.changed();
    return sub;
  }

  // a subscription held back the settled ci of its pr's head
  holdBack(id: string, sha: string): void {
    const sub = this.data.subscriptions[id];
    if (!sub || sub.held?.sha === sha) return;
    sub.held = { sha };
    this.changed();
  }

  // a poll's view of each held head: still the pr's head with ci settled is seen, anything else lets it go
  reviewHeld(repo: RepoName, settledHead: (pr: number) => string | undefined): void {
    for (const sub of Object.values(this.data.subscriptions)) {
      if (sub.repo !== repo || !sub.held || sub.scope.kind !== 'pr') continue;
      if (settledHead(sub.scope.number) !== sub.held.sha) delete sub.held;
      else if (sub.held.seen) continue;
      else sub.held.seen = true;
      this.changed();
    }
  }

  unsubscribe(id: string): boolean {
    if (!this.data.subscriptions[id]) return false;
    delete this.data.subscriptions[id];
    this.changed();
    return true;
  }

  // every subscription an agent owns, once nothing can reach it
  retireAgent(session: string, agent: string): string[] {
    const gone = Object.values(this.data.subscriptions).filter((s) => s.session === session && s.agent === agent).map((s) => s.id);
    for (const id of gone) delete this.data.subscriptions[id];
    if (gone.length) this.changed();
    return gone;
  }

  queue(b: QueueBody, titles: (issue: number) => string | undefined): Work[] {
    const now = this.now();
    const out: Work[] = [];
    let order = Math.max(0, ...Object.values(this.data.work).filter((w) => w.owner === b.session).map((w) => w.order)) + 1;
    for (const issue of b.issues) {
      const key = workKey(b.repo, issue);
      const was = this.data.work[key];
      if (was && !was.finished) {
        if (was.owner && was.owner !== b.session && this.live(was.owner)) throw new ClaimError(`${key} belongs to session ${was.owner}`, was.owner);
        was.owner = b.session;
        out.push(was);
        continue;
      }
      const w: Work = { repo: b.repo, issue, title: titles(issue) ?? `#${issue}`, owner: b.session, order: order++, queuedAt: now, updatedAt: now };
      this.data.work[key] = w;
      out.push(w);
    }
    this.changed();
    return out;
  }

  claim(b: ClaimBody, title: string | undefined): Work {
    const key = workKey(b.repo, b.issue);
    const now = this.now();
    const was = this.data.work[key];
    if (was && !was.finished && was.owner && was.owner !== b.session && this.live(was.owner) && !b.force) {
      throw new ClaimError(`${key} belongs to session ${was.owner}`, was.owner);
    }
    const base: Work = was && !was.finished ? was : { repo: b.repo, issue: b.issue, title: title ?? `#${b.issue}`, order: this.nextOrder(b.session), queuedAt: now, updatedAt: now };
    const w: Work = {
      ...base,
      owner: b.session,
      updatedAt: now,
      ...(title ? { title } : {}),
      ...(b.agent ? { agent: b.agent, claimedAt: b.agent === base.agent ? (base.claimedAt ?? now) : now } : {}),
      ...(b.routing ? { routing: b.routing } : {}),
    };
    if (b.agent && b.agent !== base.agent) {
      // a new agent on stopped or adopted work takes up what the agent it replaces still waited on
      if (base.agent && base.owner && (base.report?.state === 'stopped' || inherited(base))) this.handOver(base.owner, base.agent, b.session, b.agent);
      delete w.report;
    }
    this.data.work[key] = w;
    this.changed();
    return w;
  }

  private handOver(session: string, agent: string, to: string, toAgent: string): void {
    for (const sub of Object.values(this.data.subscriptions)) {
      if (sub.session !== session || sub.agent !== agent) continue;
      sub.session = to;
      sub.agent = toAgent;
    }
  }

  // the unfinished work an agent reported stopped on: what reaches it would resume it, so it goes to its session instead
  stopped(session: string, agent: string): Work | undefined {
    return Object.values(this.data.work).find((w) => !w.finished && w.owner === session && w.agent === agent && w.report?.state === 'stopped');
  }

  // the unfinished work whose agent nothing should reach: one that reported stopped, which a letter would resume, or one
  // gone with the session the work was adopted from. what reaches it goes to its session instead
  held(session: string, agent: string): { work: Work; why: 'stopped' | 'inherited' } | undefined {
    const w = Object.values(this.data.work).find((x) => !x.finished && x.owner === session && x.agent === agent && (x.report?.state === 'stopped' || inherited(x)));
    return w ? { work: w, why: w.report?.state === 'stopped' ? 'stopped' : 'inherited' } : undefined;
  }

  // a repo session takes over what the gone repo sessions of its repository left, once every other one there is gone;
  // a coordinator or another session never does, and nothing is taken from a live session. from names the session this
  // one goes on from in the same process, which has ended: it is handed over exactly, whatever the role
  adopt(id: string, from?: string): Adoption | undefined {
    const s = this.data.sessions[id];
    if (!s || s.gone) return undefined;
    const named = from !== undefined && from !== id ? this.data.sessions[from] : undefined;
    let gone: Session[];
    if (named) {
      named.gone = true;
      gone = [named];
      // what the ended session holds by succession it holds on as this one
      if (named.adoptions?.length) {
        s.adoptions = [...(s.adoptions ?? []), ...named.adoptions];
        delete named.adoptions;
      }
    } else {
      if (s.role !== 'repo' || !s.repo) return undefined;
      gone = Object.values(this.data.sessions).filter((x) => x.id !== id && x.role === 'repo' && x.repo === s.repo);
      if (gone.some((x) => !x.gone)) return undefined;
    }
    const ids = new Set(gone.map((x) => x.id));
    const now = this.now();
    const work = Object.values(this.data.work)
      .filter((w) => !w.finished && w.owner !== undefined && ids.has(w.owner))
      .sort((a, b) => a.order - b.order || a.queuedAt - b.queuedAt);
    let order = this.nextOrder(id);
    const taken = new Set<string>();
    const by = new Set<string>();
    const record: AdoptionRecord = { at: now, repo: s.repo ?? '', work: [], subscriptions: [], decisions: [] };
    for (const w of work) {
      const was = w.owner!;
      by.add(was);
      record.work.push({ key: workKey(w.repo, w.issue), ...(w.agent ? { agent: w.agent } : {}), was: { owner: was, order: w.order, ...(w.report ? { report: w.report } : {}), ...(w.adopted ? { adopted: w.adopted } : {}) } });
      // the gone session's own claim was that conversation's, not this one's
      if (selfWorked(w)) delete w.report;
      w.adopted = { from: was, at: now, ...(w.agent ? { agent: w.agent } : {}) };
      w.owner = id;
      w.order = order++;
      w.updatedAt = now;
      taken.add(workKey(w.repo, w.issue));
    }
    const subscriptions: string[] = [];
    for (const sub of Object.values(this.data.subscriptions)) {
      if (!ids.has(sub.session)) continue;
      // the role's own subscription, which this session holds already
      if (sub.agent === undefined && (sub.scope.kind === 'work' || sub.scope.kind === 'fleet')) continue;
      by.add(sub.session);
      record.subscriptions.push({ id: sub.id, ...(sub.agent ? { agent: sub.agent } : {}), was: sub.session });
      sub.session = id;
      subscriptions.push(sub.id);
    }
    // what was addressed to a gone session, and what went to the person only because its session was gone; what a
    // session handed on to the person itself stays the person's
    const decisions: Decision[] = [];
    for (const d of Object.values(this.data.decisions)) {
      if (!isOpen(d)) continue;
      const addressed = d.to === 'session' && d.session !== undefined && ids.has(d.session);
      const orphan = d.to === 'person' && (d.escalated === undefined || d.escalated.by === 'helm') && d.repo !== undefined && d.issue !== undefined && taken.has(workKey(d.repo, d.issue)) && this.audience(d).session === id;
      if (!addressed && !orphan) continue;
      if (addressed) by.add(d.session!);
      record.decisions.push({ id: d.id, was: { to: d.to, ...(d.session ? { session: d.session } : {}), ...(d.escalated ? { escalated: d.escalated } : {}) } });
      d.to = 'session';
      d.session = id;
      delete d.escalated;
      d.updatedAt = now;
      decisions.push(d);
    }
    if (named) this.changed();
    if (!work.length && !subscriptions.length && !decisions.length) return undefined;
    // a handover is the same session going on, and nothing in it is given back
    if (!named) s.adoptions = [...(s.adoptions ?? []), record];
    this.changed();
    return { session: id, from: [...by], work, subscriptions, decisions };
  }

  // what a session adopted by succession is a repo session's of that repository: once this one is not that, it gives
  // back what it has not acted on, to the sessions it came from. open decisions addressed to it about that work go
  // with the work, as they go to the work's owner. what it has acted on is its own now, and its record is dropped
  giveBack(id: string): GiveBack | undefined {
    const s = this.data.sessions[id];
    if (!s?.adoptions?.length) return undefined;
    const keep = s.role === 'repo' ? s.adoptions.filter((a) => a.repo === s.repo) : [];
    const back = s.adoptions.filter((a) => !keep.includes(a));
    if (!back.length) return undefined;
    if (keep.length) s.adoptions = keep;
    else delete s.adoptions;
    this.changed();
    const now = this.now();
    const out: GiveBack = { session: id, to: [], work: [], subscriptions: [], decisions: [] };
    const to = new Set<string>();
    const decided = new Set<string>();
    // newest first, so work adopted twice over ends where the oldest adoption found it
    for (const a of [...back].reverse()) {
      for (const r of a.work) {
        const w = this.data.work[r.key];
        if (!w || w.owner !== id || !current(w, r.agent, a.at)) continue;
        w.owner = r.was.owner;
        w.order = r.was.order;
        if (r.was.report) w.report = r.was.report;
        if (r.was.adopted) w.adopted = r.was.adopted;
        else delete w.adopted;
        w.updatedAt = now;
        if (r.was.owner) to.add(r.was.owner);
        out.work.push(w);
        for (const d of Object.values(this.data.decisions)) {
          if (!isOpen(d) || d.to !== 'session' || d.session !== id || d.repo !== w.repo || d.issue !== w.issue || !r.was.owner) continue;
          d.session = r.was.owner;
          d.updatedAt = now;
          decided.add(d.id);
          out.decisions.push(d);
        }
      }
      for (const r of a.subscriptions) {
        const sub = this.data.subscriptions[r.id];
        if (!sub || sub.session !== id || sub.agent !== r.agent) continue;
        sub.session = r.was;
        to.add(r.was);
        out.subscriptions.push(sub.id);
      }
      for (const r of a.decisions) {
        const d = this.data.decisions[r.id];
        if (!d || decided.has(d.id) || !isOpen(d) || d.to !== 'session' || d.session !== id) continue;
        d.to = r.was.to;
        if (r.was.session) {
          d.session = r.was.session;
          to.add(r.was.session);
        } else delete d.session;
        if (r.was.escalated) d.escalated = r.was.escalated;
        d.updatedAt = now;
        decided.add(d.id);
        out.decisions.push(d);
      }
    }
    for (const d of out.decisions) if (d.session) to.add(d.session);
    out.to = [...to];
    return out.work.length || out.subscriptions.length || out.decisions.length ? out : undefined;
  }

  // a stopped agent running again: its owner picked it back up, so the stop no longer holds
  resume(session: string, agent: string): Work | undefined {
    const w = this.stopped(session, agent);
    if (!w) return undefined;
    delete w.report;
    w.updatedAt = this.now();
    this.changed();
    return w;
  }

  report(b: ReportBody): { work: Work; decisions: Decision[] } {
    const key = workKey(b.repo, b.issue);
    const w = this.data.work[key];
    if (!w) throw new Error(`${key} is not in the ledger: claim it first`);
    if (b.agent && w.agent && b.agent !== w.agent) throw new ClaimError(`${key} has moved on: agent ${w.agent} holds it, not ${b.agent}`, w.owner ?? b.session);
    const now = this.now();
    w.report = { state: b.state, at: now, ...(b.note ? { note: b.note } : {}) };
    if (b.agent && !w.agent) w.agent = b.agent;
    if (b.plan) w.plan = b.plan.map((s) => ({ text: s.text, done: s.done }));
    w.updatedAt = now;
    if (b.state === 'abandoned') w.finished = { at: now, how: 'abandoned' };
    const from = { session: b.session, ...(b.agent ? { agent: b.agent } : {}) };
    const decisions: Decision[] = [];
    if (b.question) decisions.push(this.decide({ kind: 'question', repo: b.repo, issue: b.issue, title: b.question.title, body: b.question.body, ...(b.question.options ? { options: b.question.options } : {}), blocking: true, from }));
    for (const c of b.choices ?? []) decisions.push(this.decide({ kind: 'choice', repo: b.repo, issue: b.issue, title: c.title, body: c.body, blocking: false, from }));
    // an agent that reports anything but blocked has moved past its open questions
    if (b.state !== 'blocked') {
      for (const d of Object.values(this.data.decisions)) {
        if (d.state === 'open' && d.blocking && d.repo === b.repo && d.issue === b.issue && !decisions.includes(d) && d.from?.agent === b.agent) this.close(d, 'resolved');
      }
    }
    this.changed();
    return { work: w, decisions };
  }

  release(repo: string, issue: number, session: string, how?: 'abandoned'): Work | undefined {
    const w = this.data.work[workKey(repo, issue)];
    if (!w) return undefined;
    if (w.owner && w.owner !== session && this.live(w.owner)) throw new ClaimError(`${workKey(repo, issue)} belongs to session ${w.owner}`, w.owner);
    const now = this.now();
    if (how) w.finished = { at: now, how };
    else {
      delete w.owner;
      delete w.agent;
      delete w.report;
    }
    w.updatedAt = now;
    this.changed();
    return w;
  }

  order(session: string, keys: string[]): void {
    keys.forEach((k, i) => {
      const w = this.data.work[k];
      if (w && w.owner === session) w.order = i + 1;
    });
    this.changed();
  }

  // the forge says an issue's work is over
  // notes the phase a work item is in now, when it is not the one it was last seen in
  phase(repo: string, issue: number, phase: Phase): void {
    const w = this.data.work[workKey(repo, issue)];
    if (!w) return;
    const history = (w.history ??= []);
    if (history.at(-1)?.phase === phase) return;
    history.push({ phase, at: this.now() });
    if (history.length > HISTORY_KEEP) history.splice(0, history.length - HISTORY_KEEP);
    this.changed();
  }

  // what an ended agent left running in the work's worktree, replaced at each ending
  leftovers(repo: string, issue: number, found: Leftover[]): Work | undefined {
    const w = this.data.work[workKey(repo, issue)];
    if (!w) return undefined;
    if (JSON.stringify(w.leftovers ?? []) === JSON.stringify(found)) return w;
    if (found.length) w.leftovers = found;
    else delete w.leftovers;
    w.updatedAt = this.now();
    this.changed();
    return w;
  }

  // at is when it finished, when that was before now: a close helm learns of late
  finish(repo: string, issue: number, how: 'merged' | 'closed', at = this.now()): Work | undefined {
    const w = this.data.work[workKey(repo, issue)];
    if (!w || w.finished) return undefined;
    w.finished = { at: Math.min(at, this.now()), how };
    w.updatedAt = this.now();
    this.changed();
    return w;
  }

  decide(b: DecisionBody & { key?: string; condition?: string }): Decision {
    const now = this.now();
    const to = this.audience(b);
    const d: Decision = {
      id: `d${++this.data.counters.decision}`,
      kind: b.kind,
      title: b.title,
      body: b.body,
      blocking: b.blocking,
      to: to.to,
      ...(to.session ? { session: to.session } : {}),
      state: 'open',
      createdAt: now,
      updatedAt: now,
      ...(b.repo ? { repo: b.repo } : {}),
      ...(b.issue !== undefined ? { issue: b.issue } : {}),
      ...(b.options ? { options: b.options } : {}),
      ...(b.from ? { from: b.from } : {}),
      ...(b.key ? { key: b.key } : {}),
      ...(b.condition !== undefined ? { condition: b.condition } : {}),
    };
    this.data.decisions[d.id] = d;
    this.changed();
    return d;
  }

  // an agent's question and a stall go to the session that owns the work, while it is live; everything else, and what
  // such a session is not there to take, goes to the person
  private audience(b: Pick<DecisionBody, 'kind' | 'repo' | 'issue' | 'from'>): { to: Audience; session?: string } {
    if (!((b.kind === 'question' && b.from?.agent !== undefined) || b.kind === 'stall')) return { to: 'person' };
    const owner = (b.repo && b.issue !== undefined ? this.data.work[workKey(b.repo, b.issue)]?.owner : undefined) ?? b.from?.session;
    return owner && this.live(owner) ? { to: 'session', session: owner } : { to: 'person' };
  }

  // the session a decision is addressed to hands it on to the person
  escalate(id: string, by: string, note?: string): Decision {
    const d = this.data.decisions[id];
    if (!d) throw new Error(`no decision ${id}`);
    if (!isOpen(d)) throw new Error(d.state === 'open' ? `${id} is a record for review, not a decision` : `decision ${id} is already ${d.state}`);
    if (d.to !== 'session') throw new Error(`decision ${id} is already the person's`);
    this.toPerson(d, by, note);
    return d;
  }

  // the open decisions addressed to a session that is gone, handed on to the person
  orphaned(session: string): Decision[] {
    const out = Object.values(this.data.decisions).filter((d) => isOpen(d) && d.to === 'session' && d.session === session);
    for (const d of out) this.toPerson(d, 'helm', `session ${session} is gone`);
    return out;
  }

  private toPerson(d: Decision, by: string, note?: string): void {
    d.to = 'person';
    delete d.session;
    d.escalated = { by, at: this.now(), ...(note ? { note } : {}) };
    d.updatedAt = this.now();
    this.changed();
  }

  // a condition helmd watches: raised once while it holds, resolved once it no longer does. a person who dismissed or
  // answered it has seen this condition, so it is not raised again until the condition changes or ends
  raise(key: string, condition: string, b: DecisionBody): Decision | undefined {
    const mine = Object.values(this.data.decisions).filter((d) => d.key === key);
    const open = mine.find((d) => d.state === 'open');
    if (open) {
      // still the same decision, now standing for what holds now
      if (open.condition !== condition || open.title !== b.title || open.body !== b.body) {
        Object.assign(open, { condition, title: b.title, body: b.body, updatedAt: this.now() });
        this.changed();
      }
      return undefined;
    }
    if (mine.some((d) => (d.state === 'dismissed' || d.state === 'answered') && d.condition === condition)) return undefined;
    return this.decide({ ...b, key, condition });
  }

  // the condition ended: an open decision on it is resolved, and a dismissal of it holds no longer
  resolveKey(key: string): Decision | undefined {
    let open: Decision | undefined;
    for (const d of Object.values(this.data.decisions)) {
      if (d.key !== key) continue;
      if (d.state === 'open') {
        open = d;
        this.close(d, 'resolved');
      } else if (d.condition !== undefined) {
        delete d.condition;
        this.changed();
      }
    }
    return open;
  }

  answer(id: string, a: Omit<Answer, 'at'>): Decision {
    const d = this.data.decisions[id];
    if (!d) throw new Error(`no decision ${id}`);
    if (d.state !== 'open' && d.kind !== 'routing') throw new Error(`decision ${id} is already ${d.state}`);
    d.answer = { ...a, at: this.now() };
    d.state = 'answered';
    d.updatedAt = this.now();
    this.changed();
    return d;
  }

  dismiss(id: string): Decision {
    const d = this.data.decisions[id];
    if (!d) throw new Error(`no decision ${id}`);
    this.close(d, 'dismissed');
    return d;
  }

  private close(d: Decision, state: 'resolved' | 'dismissed'): void {
    d.state = state;
    d.updatedAt = this.now();
    this.changed();
  }

  post(l: Omit<Letter, 'id' | 'at'>): Letter {
    const letter: Letter = { ...l, id: `l${++this.data.counters.letter}`, at: this.now() };
    this.data.letters[letter.id] = letter;
    this.changed();
    return letter;
  }

  // exactly once: the first caller gets the letter, every later one nothing
  take(id: string): Letter | undefined {
    const l = this.data.letters[id];
    if (!l) return undefined;
    delete this.data.letters[id];
    this.changed();
    return l;
  }

  pending(session: string, agent?: string): Letter[] {
    return Object.values(this.data.letters)
      .filter((l) => l.session === session && (agent === undefined || l.agent === agent))
      .sort((a, b) => a.at - b.at);
  }

  record(events: readonly HelmEvent[]): void {
    if (!events.length) return;
    this.data.events = [...this.data.events, ...events].slice(-EVENT_LOG);
    this.changed();
  }

  // an issue newly opened in a watched repository, once: a later sighting of the same issue changes nothing
  opened(repo: RepoName, issue: number, openedAt: number, alone: boolean): void {
    const key = workKey(repo, issue);
    if (this.data.unowned[key]) return;
    this.data.unowned[key] = { repo, issue, openedAt, alone };
    this.changed();
  }

  // the opened issues not yet delivered as unowned
  unownedWaiting(): UnownedIssue[] {
    return Object.values(this.data.unowned).filter((u) => u.delivered === undefined);
  }

  // a waiting issue settled: delivered, and remembered so it never is again, or let go as owned or closed
  settleUnowned(key: string, delivered: boolean): void {
    const u = this.data.unowned[key];
    if (!u || u.delivered !== undefined) return;
    if (delivered) u.delivered = this.now();
    else delete this.data.unowned[key];
    this.changed();
  }

  live(session: string): boolean {
    const s = this.data.sessions[session];
    return s !== undefined && !s.gone;
  }

  // marks overdue sessions gone and drops what has aged out; returns the sessions newly gone
  sweep(goneMs: number): Session[] {
    const now = this.now();
    const newlyGone: Session[] = [];
    let dropped = false;
    const drop = <T>(table: Record<string, T>, key: string) => {
      delete table[key];
      dropped = true;
    };
    for (const s of Object.values(this.data.sessions)) {
      if (!s.gone && now - s.seenAt > goneMs) {
        s.gone = true;
        newlyGone.push(s);
      }
      if (s.gone && now - s.seenAt > SESSION_KEEP_MS) {
        drop(this.data.sessions, s.id);
        for (const sub of Object.values(this.data.subscriptions)) if (sub.session === s.id) drop(this.data.subscriptions, sub.id);
        for (const l of Object.values(this.data.letters)) if (l.session === s.id) drop(this.data.letters, l.id);
      }
    }
    for (const [k, w] of Object.entries(this.data.work)) if (w.finished && now - w.finished.at > WORK_KEEP_MS) drop(this.data.work, k);
    for (const [k, d] of Object.entries(this.data.decisions)) if (d.state !== 'open' && now - d.updatedAt > DECISION_KEEP_MS) drop(this.data.decisions, k);
    // long past any sighting as newly opened, which could deliver it again
    for (const [k, u] of Object.entries(this.data.unowned)) if (u.delivered !== undefined && now - u.delivered > WORK_KEEP_MS) drop(this.data.unowned, k);
    if (newlyGone.length || dropped) this.changed();
    return newlyGone;
  }

  private nextOrder(session: string): number {
    return Math.max(0, ...Object.values(this.data.work).filter((w) => w.owner === session).map((w) => w.order)) + 1;
  }
}
