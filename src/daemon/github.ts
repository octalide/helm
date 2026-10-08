import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Rate = { remaining: number; limit: number; resetAt: number };

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type Conditional<T> = { changed: boolean; body: T };

type Cached = { etag: string; body: unknown };

export type TokenSource = () => Promise<string>;

// the token gh is logged in with; the daemon holds no credential of its own
export const ghToken: TokenSource = async () => {
  const { stdout } = await run('gh', ['auth', 'token'], { timeout: 15_000 });
  const token = stdout.trim();
  if (!token) throw new Error('gh auth token printed nothing: run gh auth login');
  return token;
};

export type Fetch = typeof fetch;

// rest and graphql over fetch. a conditional get keeps the last body per url, so an unchanged resource answers 304,
// costs no quota and hands back what it held
export class GitHub {
  // by the pool github counts the request against (core, graphql, ...)
  readonly rates: Record<string, Rate> = {};
  private token?: string;
  private readonly cache = new Map<string, Cached>();
  private readonly tokens: TokenSource;
  private readonly fetch: Fetch;
  private readonly base: string;

  constructor(tokens: TokenSource = ghToken, fetchImpl: Fetch = fetch, base = 'https://api.github.com') {
    this.tokens = tokens;
    this.fetch = fetchImpl;
    this.base = base;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path, {});
    return (await res.json()) as T;
  }

  async conditional<T>(path: string): Promise<Conditional<T>> {
    const held = this.cache.get(path);
    const res = await this.request(path, held ? { 'if-none-match': held.etag } : {});
    if (res.status === 304 && held) return { changed: false, body: held.body as T };
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag) this.cache.set(path, { etag, body });
    return { changed: true, body };
  }

  async text(path: string): Promise<string> {
    return (await this.request(path, {})).text();
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request('graphql', { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ query, variables }) });
    const out = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (out.errors?.length) throw new GitHubError(`graphql: ${out.errors.map((e) => e.message).join('; ')}`, 200);
    if (!out.data) throw new GitHubError('graphql answered no data', 200);
    return out.data;
  }

  // forgets a url's etag, so its next conditional read is a full one
  forget(path: string): void {
    this.cache.delete(path);
  }

  private async request(path: string, headers: Record<string, string>, init: { method?: string; body?: string } = {}, retried = false): Promise<Response> {
    this.token ??= await this.tokens();
    const res = await this.fetch(`${this.base}/${path}`, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'helmd',
        ...headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
    this.readRate(res);
    if (res.status === 401 && !retried) {
      this.token = undefined;
      return this.request(path, headers, init, true);
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(`${init.method ?? 'GET'} ${path}: http ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    return res;
  }

  private readRate(res: Response): void {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const pool = res.headers.get('x-ratelimit-resource');
    if (pool && Number.isFinite(remaining) && Number.isFinite(limit) && res.headers.has('x-ratelimit-remaining')) {
      this.rates[pool] = { remaining, limit, resetAt: reset * 1000 };
    }
  }
}
