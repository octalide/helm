import type {
  AnswerBody,
  Answered,
  ClaimBody,
  ConfigView,
  DecisionBody,
  Health,
  IssueDetail,
  OrderBody,
  QueueBody,
  RegisterBody,
  ReleaseBody,
  ReportBody,
  SubscribeBody,
} from '../core/protocol.ts';
import type { AgentRecord, Decision, Fleet, Letter, RepoName, RepoView, Session, SessionRole, Subscription, Work } from '../core/types.ts';

export type HttpLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; socketPath: string }) => Promise<{ status: number; ok: boolean; text: string }>;

export class HelmError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const enc = encodeURIComponent;

// helmd's socket api as typed calls. every failure is a HelmError with the daemon's own words
export class HelmClient {
  readonly socket: string;
  private readonly http: HttpLike;

  constructor(http: HttpLike, socket: string) {
    this.http = http;
    this.socket = socket;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res;
    try {
      res = await this.http(`http://helmd${path}`, {
        method,
        socketPath: this.socket,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
    } catch (e) {
      throw new HelmError(0, `helmd unreachable on ${this.socket}: ${(e as Error).message}`);
    }
    const parsed = res.text ? safeJson(res.text) : null;
    if (!res.ok) {
      const p = parsed as { error?: string; detail?: unknown } | null;
      throw new HelmError(res.status, p?.error ?? `http ${res.status}`, p?.detail);
    }
    return (parsed ?? res.text) as T;
  }

  async text(path: string): Promise<string> {
    const res = await this.http(`http://helmd${path}`, { socketPath: this.socket }).catch((e: Error) => {
      throw new HelmError(0, `helmd unreachable: ${e.message}`);
    });
    if (!res.ok) throw new HelmError(res.status, (safeJson(res.text) as { error?: string } | null)?.error ?? `http ${res.status}`);
    return res.text;
  }

  health = () => this.call<Health>('GET', '/v1/health');
  shutdown = () => this.call<unknown>('POST', '/v1/shutdown');
  fleet = (lite = false) => this.call<Fleet>('GET', `/v1/fleet${lite ? '?lite=1' : ''}`);
  config = (repo?: RepoName) => this.call<ConfigView>('GET', `/v1/config${repo ? `?repo=${enc(repo)}` : ''}`);
  register = (b: RegisterBody) => this.call<Session>('POST', '/v1/sessions', b);
  heartbeat = (id: string, agents: AgentRecord[]) => this.call<Session>('POST', `/v1/sessions/${enc(id)}/heartbeat`, { agents });
  role = (id: string, role: SessionRole, repo?: RepoName) => this.call<Session>('POST', `/v1/sessions/${enc(id)}/role`, { role, ...(repo ? { repo } : {}) });
  end = (id: string) => this.call<unknown>('POST', `/v1/sessions/${enc(id)}/end`);
  letters = (session: string, agent?: string) => this.call<Letter[]>('GET', `/v1/letters?session=${enc(session)}${agent ? `&agent=${enc(agent)}` : ''}`);
  // undefined once another taker had it
  take = (id: string) =>
    this.call<Letter>('POST', `/v1/letters/${enc(id)}/take`).catch((e: unknown) => {
      if (e instanceof HelmError && e.status === 404) return undefined;
      throw e;
    });
  subscribe = (b: SubscribeBody) => this.call<Subscription>('POST', '/v1/subscriptions', b);
  unsubscribe = (id: string) => this.call<{ removed: boolean }>('DELETE', `/v1/subscriptions/${enc(id)}`);
  retire = (session: string, agent: string) => this.call<{ retired: string[] }>('POST', '/v1/subscriptions/retire', { session, agent });
  queue = (b: QueueBody) => this.call<Work[]>('POST', '/v1/work/queue', b);
  claim = (b: ClaimBody) => this.call<Work>('POST', '/v1/work/claim', b);
  report = (b: ReportBody) => this.call<{ work: Work; decisions: Decision[] }>('POST', '/v1/work/report', b);
  release = (b: ReleaseBody) => this.call<Work | null>('POST', '/v1/work/release', b);
  order = (b: OrderBody) => this.call<{ ordered: number }>('POST', '/v1/work/order', b);
  decide = (b: DecisionBody) => this.call<Decision>('POST', '/v1/decisions', b);
  answer = (id: string, b: AnswerBody) => this.call<Answered>('POST', `/v1/decisions/${enc(id)}/answer`, b);
  dismiss = (id: string) => this.call<Decision>('POST', `/v1/decisions/${enc(id)}/dismiss`);
  repo = (repo: RepoName) => this.call<RepoView>('GET', `/v1/repos/${repo}`);
  poll = (repo: RepoName) => this.call<RepoView>('POST', `/v1/repos/${repo}/poll`);
  issue = (repo: RepoName, n: number) => this.call<IssueDetail>('GET', `/v1/repos/${repo}/issues/${n}`);
  log = (repo: RepoName, job: number, q: { tail?: number; grep?: string; errors?: boolean }) =>
    this.text(`/v1/repos/${repo}/jobs/${job}/log?${[q.tail ? `tail=${q.tail}` : '', q.grep ? `grep=${enc(q.grep)}` : '', q.errors ? 'errors=1' : ''].filter(Boolean).join('&')}`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
