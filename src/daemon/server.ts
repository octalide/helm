import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { AnswerBody, ClaimBody, DecisionBody, EscalateBody, Health, HeartbeatBody, OrderBody, QueueBody, RegisterBody, ReleaseBody, ReportBody, RoleBody, StreamFrame, SubscribeBody } from '../core/protocol.ts';
import { PROTOCOL } from '../core/protocol.ts';
import type { Daemon } from './helmd.ts';
import { ClaimError } from './ledger.ts';

type Ctx = { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: () => Promise<unknown> };

type Handler = (c: Ctx) => Promise<unknown> | unknown;

// web: reachable from the page on 127.0.0.1, not only from the socket the sessions use
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; web: boolean };

export class HttpError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// a sentinel a handler returns once it has written the response itself (a stream)
const STREAMED = Symbol('streamed');

const REPO = '(?<owner>[^/]+)/(?<name>[^/]+)';

function compile(method: string, path: string, handler: Handler, web = false): Route {
  const keys: string[] = [];
  const src = path.replace(/:repo/g, REPO).replace(/:(\w+)/g, (_, k: string) => {
    keys.push(k);
    return `(?<${k}>[^/]+)`;
  });
  return { method, pattern: new RegExp(`^${src}$`), keys, handler, web };
}

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new HttpError(400, message);
}

const num = (v: string | undefined, what: string): number => {
  const n = Number(v);
  need(Number.isInteger(n) && n > 0, `${what} must be a positive integer`);
  return n;
};

export function routes(d: Daemon, stop: () => void): Route[] {
  const repoOf = (p: Record<string, string>) => `${p.owner}/${p.name}`;
  return [
    compile('GET', '/v1/health', (): Health => ({ version: d.version, protocol: PROTOCOL, pid: process.pid, startedAt: d.startedAt, web: `http://127.0.0.1:${d.config.web.port}/` }), true),
    compile('POST', '/v1/shutdown', () => {
      setTimeout(stop, 50);
      return { stopping: true };
    }),
    compile('GET', '/v1/fleet', ({ query }) => d.fleet(query.get('lite') === '1'), true),
    compile('GET', '/v1/config', ({ query }) => d.configFor(query.get('repo') ?? undefined), true),
    compile('POST', '/v1/sessions', async ({ body }) => {
      const b = (await body()) as RegisterBody;
      need(b?.id && b.cwd, 'id and cwd are required');
      return d.register(b);
    }),
    compile('POST', '/v1/sessions/:id/heartbeat', async ({ params, body }) => {
      const b = (await body()) as HeartbeatBody;
      const s = d.heartbeat(params.id!, b.agents ?? []);
      if (!s) throw new HttpError(404, `session ${params.id} is not registered`);
      return s;
    }),
    compile('POST', '/v1/sessions/:id/role', async ({ params, body }) => {
      const b = (await body()) as RoleBody;
      need(b.role === 'coordinator' || b.role === 'repo' || b.role === 'other', 'role is coordinator, repo or other');
      const s = d.setRole(params.id!, b.role, b.repo);
      if (!s) throw new HttpError(404, `session ${params.id} is not registered`);
      return s;
    }),
    compile('POST', '/v1/sessions/:id/end', ({ params }) => {
      d.endSession(params.id!);
      return { ended: true };
    }),
    compile('GET', '/v1/sessions/:id/stream', ({ params, req, res }) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const off = d.stream(params.id!, (f) => res.write(`${JSON.stringify(f)}\n`));
      req.on('close', off);
      return STREAMED;
    }),
    compile('GET', '/v1/letters', ({ query }) => {
      const session = query.get('session');
      need(session, 'session is required');
      return d.ledger.pending(session, query.get('agent') ?? undefined);
    }),
    compile('POST', '/v1/letters/:id/take', ({ params }) => {
      const l = d.ledger.take(params.id!);
      if (!l) throw new HttpError(404, `letter ${params.id} was taken`);
      return l;
    }),
    compile('POST', '/v1/subscriptions', async ({ body }) => {
      const b = (await body()) as SubscribeBody;
      need(b?.session && b.scope?.kind, 'session and scope are required');
      try {
        return await d.subscribe(b);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }),
    compile('DELETE', '/v1/subscriptions/:id', ({ params }) => ({ removed: d.ledger.unsubscribe(params.id!) })),
    compile('POST', '/v1/subscriptions/retire', async ({ body }) => {
      const b = (await body()) as { session: string; agent: string };
      need(b?.session && b.agent, 'session and agent are required');
      return { retired: d.ledger.retireAgent(b.session, b.agent) };
    }),
    compile('POST', '/v1/work/queue', async ({ body }) => {
      const b = (await body()) as QueueBody;
      need(b?.session && b.repo && Array.isArray(b.issues) && b.issues.length, 'session, repo and issues are required');
      return claiming(() => d.queue(b));
    }),
    compile('POST', '/v1/work/claim', async ({ body }) => {
      const b = (await body()) as ClaimBody;
      need(b?.session && b.repo && b.issue, 'session, repo and issue are required');
      return claiming(() => d.claim(b));
    }),
    compile('POST', '/v1/work/report', async ({ body }) => {
      const b = (await body()) as ReportBody;
      need(b?.session && b.repo && b.issue && b.state, 'session, repo, issue and state are required');
      try {
        return d.report(b);
      } catch (e) {
        if (e instanceof ClaimError) throw new HttpError(409, e.message, { owner: e.owner });
        throw new HttpError(404, (e as Error).message);
      }
    }),
    compile('POST', '/v1/work/release', async ({ body }) => {
      const b = (await body()) as ReleaseBody;
      need(b?.session && b.repo && b.issue, 'session, repo and issue are required');
      return claiming(() => d.ledger.release(b.repo, b.issue, b.session, b.how) ?? null);
    }),
    compile('POST', '/v1/work/order', async ({ body }) => {
      const b = (await body()) as OrderBody;
      need(b?.session && Array.isArray(b.keys), 'session and keys are required');
      d.ledger.order(b.session, b.keys);
      return { ordered: b.keys.length };
    }),
    compile('POST', '/v1/decisions', async ({ body }) => {
      const b = (await body()) as DecisionBody;
      need(b?.kind && b.title && typeof b.blocking === 'boolean', 'kind, title and blocking are required');
      return d.decide({ ...b, body: b.body ?? '' });
    }),
    compile(
      'POST',
      '/v1/decisions/:id/answer',
      async ({ params, body }) => {
        const b = (await body()) as AnswerBody;
        need(b && (b.text || b.option), 'text or option is required');
        try {
          return d.answer(params.id!, { text: b.text ?? '', ...(b.option ? { option: b.option } : {}), by: b.by || 'human' });
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
      },
      true,
    ),
    compile(
      'POST',
      '/v1/decisions/:id/escalate',
      async ({ params, body }) => {
        const b = ((await body()) ?? {}) as EscalateBody;
        try {
          return d.escalate(params.id!, { by: b.by || 'human', ...(b.note ? { note: b.note } : {}) });
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
      },
      true,
    ),
    compile(
      'POST',
      '/v1/decisions/:id/dismiss',
      ({ params }) => {
        try {
          return d.ledger.dismiss(params.id!);
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
      },
      true,
    ),
    compile('GET', '/v1/repos/:repo', ({ params }) => d.ask(repoOf(params)), true),
    compile('POST', '/v1/repos/:repo/poll', async ({ params }) => {
      await d.ask(repoOf(params));
      await d.pollRepo(repoOf(params), true);
      return d.repoView(repoOf(params));
    }),
    compile('GET', '/v1/repos/:repo/issues/:n', ({ params }) => d.issue(repoOf(params), num(params.n, 'issue')), true),
    compile('GET', '/v1/repos/:repo/runs/:id', ({ params }) => d.run(repoOf(params), num(params.id, 'run')), true),
    compile(
      'GET',
      '/v1/repos/:repo/jobs/:id/log',
      async ({ params, query, res }) => {
        const text = await d.jobLog(repoOf(params), num(params.id, 'job'), {
          ...(query.get('tail') ? { tail: Number(query.get('tail')) } : {}),
          ...(query.get('grep') ? { grep: query.get('grep')! } : {}),
          errors: query.get('errors') === '1',
        });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(text);
        return STREAMED;
      },
      true,
    ),
    compile(
      'GET',
      '/v1/events',
      ({ req, res }) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': helm\n\n');
        const off = d.watch((f: StreamFrame) => res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`));
        req.on('close', off);
        return STREAMED;
      },
      true,
    ),
  ];
}

function claiming<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ClaimError) throw new HttpError(409, e.message, { owner: e.owner });
    throw new HttpError(400, (e as Error).message);
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) reject(new HttpError(413, 'body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'body is not json'));
      }
    });
    req.on('error', reject);
  });
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export type Listeners = { socket: Server; web?: Server };

// the same routes on two listeners: the socket, which only the user can open, and 127.0.0.1 for the page, where a
// request is taken only when its host is this server and a write only when it comes from this server's own page
export function handler(table: Route[], opts: { web: boolean; port?: number; static?: string }) {
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://helmd');
    try {
      if (opts.web) {
        if (!hosts.has(req.headers.host ?? '')) throw new HttpError(421, 'unknown host');
        if (req.method !== 'GET' && !origins.has(req.headers.origin ?? '')) throw new HttpError(403, 'cross-origin write refused');
        if (req.method === 'GET' && !url.pathname.startsWith('/v1/') && opts.static) return await serveStatic(opts.static, url.pathname, res);
      }
      const route = table.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route || (opts.web && !route.web)) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
      const params = { ...(route.pattern.exec(url.pathname)?.groups ?? {}) };
      let body: Promise<unknown> | undefined;
      const out = await route.handler({ req, res, params, query: url.searchParams, body: () => (body ??= readBody(req)) });
      if (out === STREAMED) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? null));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message, ...(e instanceof HttpError && e.detail ? { detail: e.detail } : {}) }));
    }
  };
}

async function serveStatic(root: string, path: string, res: ServerResponse): Promise<void> {
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[\w.-]+$/.test(name)) throw new HttpError(404, 'not found');
  const body = await readFile(join(root, name)).catch(() => undefined);
  if (!body) throw new HttpError(404, 'not found');
  res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(body);
}

export function listen(server: Server, target: string | { port: number; host: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (typeof target === 'string') server.listen(target, () => resolve());
    else server.listen(target.port, target.host, () => resolve());
  });
}

export { createServer };
