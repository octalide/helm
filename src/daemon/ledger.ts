import type { ClaimBody, DecisionBody, QueueBody, RegisterBody, ReportBody, SubscribeBody } from '../core/protocol.ts';
import { isOpen } from '../core/decision.ts';
import { workKey } from '../core/protocol.ts';
import type { AgentRecord, Answer, Audience, Decision, HelmEvent, Leftover, Letter, Phase, RepoName, Session, SessionRole, Subscription, Work } from '../core/types.ts';

// bumped when the stored shape changes; an older file is migrated or refused, never read as this one
export const LEDGER_VERSION = 2;

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
};

// an older file brought up to this shape, in place
export function migrate(data: LedgerData): LedgerData {
  if (data.version === 1) {
    // version 1 addressed nothing: every decision in it was in the person's inbox, and stays there
    for (const d of Object.values(data.decisions)) d.to ??= 'person';
    data.version = 2;
  }
  return data;
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

  register(b: RegisterBody): Session {
    const now = this.now();
    const was = this.data.sessions[b.id];
    const role: SessionRole = b.role ?? was?.role ?? (b.repo ? 'repo' : 'other');
    const s: Session = {
      id: b.id,
      role,
      cwd: b.cwd,
      agents: was?.agents ?? [],
      startedAt: was?.startedAt ?? now,
      seenAt: now,
      ...((b.repo ?? was?.repo) ? { repo: b.repo ?? was?.repo } : {}),
      ...((b.title ?? was?.title) ? { title: b.title ?? was?.title } : {}),
    };
    this.data.sessions[b.id] = s;
    this.ensureRoleSubscription(s);
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
    for (const sub of Object.values(this.data.subscriptions)) {
      if (sub.session === id && sub.agent === undefined && (sub.scope.kind === 'work' || sub.scope.kind === 'fleet')) delete this.data.subscriptions[sub.id];
    }
    this.ensureRoleSubscription(s);
    this.changed();
    return s;
  }

  endSession(id: string): void {
    const s = this.data.sessions[id];
    if (!s) return;
    s.gone = true;
    this.changed();
  }

  // a repo session hears its own work and a coordinator the fleet, unasked: the subscription is listed and removable
  private ensureRoleSubscription(s: Session): void {
    const kind = s.role === 'coordinator' ? 'fleet' : s.role === 'repo' ? 'work' : undefined;
    if (!kind) return;
    const has = Object.values(this.data.subscriptions).some((x) => x.session === s.id && x.agent === undefined && x.scope.kind === kind);
    if (!has) this.subscribe({ session: s.id, scope: { kind } });
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
      // a new agent on stopped work takes up what the stopped one still waited on
      if (base.agent && base.owner && base.report?.state === 'stopped') this.handOver(base.owner, base.agent, b.session, b.agent);
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
    if (newlyGone.length || dropped) this.changed();
    return newlyGone;
  }

  private nextOrder(session: string): number {
    return Math.max(0, ...Object.values(this.data.work).filter((w) => w.owner === session).map((w) => w.order)) + 1;
  }
}
