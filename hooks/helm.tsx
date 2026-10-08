import type { EngineInterface, Register } from 'claude-code';
import { helmPaths, type PathEnv } from '../src/core/paths.ts';
import { PROTOCOL, type StreamFrame } from '../src/core/protocol.ts';
import { compareVersions, isRepoName, repoOfRemote } from '../src/core/repo.ts';
import type { AgentRecord, AgentStatus, RepoName, SessionRole } from '../src/core/types.ts';
import { HelmClient, HelmError } from '../src/mod/client.ts';
import { Mailbox } from '../src/mod/mailbox.ts';
import { type Tool, TOOLS } from '../src/mod/tools.ts';
import { PLUGIN, ROLES, type Runtime, toolEnv } from './runtime.ts';

type $ = EngineInterface;

// what a tool that reaches the engine is handed: plain functions over $, built here
export type Port = Record<string, never>;

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 3_000;

let rt: Runtime | undefined;

async function pathEnv($: $): Promise<PathEnv> {
  const env: PathEnv = { HOME: (await $.env.get('HOME')) ?? '/' };
  const set = (k: keyof PathEnv, v: string | undefined) => {
    if (v) env[k] = v;
  };
  set('XDG_RUNTIME_DIR', await $.env.get('XDG_RUNTIME_DIR'));
  set('XDG_STATE_HOME', await $.env.get('XDG_STATE_HOME'));
  set('XDG_CONFIG_HOME', await $.env.get('XDG_CONFIG_HOME'));
  set('XDG_CACHE_HOME', await $.env.get('XDG_CACHE_HOME'));
  set('HELM_SOCKET', await $.env.get('HELM_SOCKET'));
  set('HELM_HOME', await $.env.get('HELM_HOME'));
  return env;
}

async function clientFor($: $): Promise<HelmClient> {
  const paths = helmPaths(await pathEnv($));
  return new HelmClient(async (url, init) => {
    const res = await $.http.fetch(url, init);
    return { status: res.status, ok: res.ok, text: res.text };
  }, paths.socket);
}

function daemonArgv($: $, cmd: string, ...rest: string[]): string[] {
  return ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/src/daemon/main.ts`, cmd, ...rest];
}

// helmd answering at this mod's version or newer; an older one is replaced, a newer one is used as it is
async function ensureDaemon($: $, client: HelmClient, version: string): Promise<void> {
  const up = await client.health().catch(() => undefined);
  if (up && up.protocol === PROTOCOL && compareVersions(up.version, version) >= 0) return;
  const cmd = up ? 'restart' : 'start';
  const r = await $.process.run(daemonArgv($, cmd), { timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`helmd ${cmd} failed: ${(r.stderr || r.stdout).trim()}`);
}

async function sessionRepo($: $): Promise<RepoName | undefined> {
  const r = await $.session.repo();
  return r?.remote ? repoOfRemote(r.remote) : undefined;
}

async function agentRecords($: $): Promise<AgentRecord[]> {
  return (await $.agent.list()).map((a) => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status as AgentStatus,
    ...(a.name ? { name: a.name } : {}),
    ...(a.parentId ? { parentId: a.parentId } : {}),
  }));
}

async function bind($: $, r: Runtime): Promise<void> {
  r.session = await $.session.id();
  await r.client.register({ id: r.session, cwd: await $.session.cwd(), role: r.role, ...(r.repo ? { repo: r.repo } : {}) });
}

function port(): Port {
  return {};
}

// letters and change notices from helmd, for the life of this module; reconnects whenever helmd goes away
function pump($: $, r: Runtime): void {
  const run = async () => {
    try {
      let buf = '';
      for await (const piece of $.process.spawn({ argv: daemonArgv($, 'stream', r.session) })) {
        if (!r.alive) break;
        if (piece.stream !== 'stdout') continue;
        buf += piece.text;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) await frame(r, JSON.parse(line) as StreamFrame);
        }
      }
    } catch (e) {
      $.ui.log(`helm: stream ended: ${(e as Error).message}`, { to: 'debug' });
    }
    if (!r.alive) return;
    r.timers.push(
      $.clock.after(RECONNECT_MS, () => {
        void ensureDaemon($, r.client, r.version)
          .then(() => bind($, r))
          .catch((e: Error) => $.ui.log(`helm: helmd unavailable: ${e.message}`, { to: 'debug' }))
          .finally(() => r.alive && pump($, r));
      }),
    );
  };
  void run();
}

async function frame(r: Runtime, f: StreamFrame): Promise<void> {
  if (f.type === 'letter') await r.mailbox.receive(f.letter);
}

async function helpText(r: Runtime): Promise<string> {
  const h = await r.client.health().catch(() => undefined);
  return [
    `helm ${r.version} · session ${r.session} · role ${r.role}${r.repo ? ` · ${r.repo}` : ''}`,
    h ? `helmd ${h.version} pid ${h.pid} · ${h.web ?? ''}` : 'helmd not answering',
    'commands: /helm role coordinator|repo|other [owner/name] · /helm web · /helm restart',
  ].join('\n');
}

export const register: Register = (on) => {
  const tools: Tool<Port>[] = [...TOOLS];

  // outermost on every tool: letters waiting for the calling loop ride the result
  on('tool.call', async ($, e, next) => {
    const out = await next(e);
    const r = rt;
    if (!r?.alive || out.deny !== undefined) return out;
    const texts = await r.mailbox.attach(e.agentId).catch(() => []);
    return texts.length ? { ...out, context: [...(out.context ?? []), ...texts] } : out;
  }).catch(($, e, next) => next(e));

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    if (rt) {
      rt.alive = false;
      rt.timers.forEach((t) => t.cancel());
      rt.mailbox.stop();
    }
    const client = await clientFor($);
    const version = (JSON.parse(await $.fs.read(`${$.plugin.root}/package.json`)) as { version: string }).version;
    const repo = await sessionRepo($);
    const asked = (await $.env.get('HELM_ROLE')) as SessionRole | undefined;
    const r: Runtime = {
      client,
      version,
      home: (await $.env.get('HOME')) ?? '',
      session: await $.session.id(),
      role: asked && ROLES.includes(asked) ? asked : repo ? 'repo' : 'other',
      alive: true,
      timers: [],
      ...(repo ? { repo } : {}),
      mailbox: new Mailbox({
        now: Date.now,
        take: (id) => client.take(id),
        submit: async (text) => void (await $.prompt.submit({ text })),
        send: async (agent, text) => {
          const sent = await $.session.send({ to: { agentId: agent }, text });
          return sent.isDelivered ? undefined : sent.reason;
        },
        retire: async (agent) => void (await client.retire(r.session, agent)),
        status: async (agent) => (await $.agent.list()).find((a) => a.id === agent)?.status as AgentStatus | undefined,
        after: (ms, fn) => $.clock.after(ms, () => void fn()),
        log: (line) => $.ui.log(line, { to: 'debug' }),
      }),
    };
    rt = r;

    for (const t of tools) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: !t.eager });
    await $.command.register({ name: PLUGIN, description: 'helm: status, role, web page' });
    try {
      await ensureDaemon($, client, version);
      await bind($, r);
    } catch (err) {
      $.ui.log(`helm: ${(err as Error).message}`);
    }
    pump($, r);
    r.timers.push(
      $.clock.every(HEARTBEAT_MS, () => {
        void (async () => {
          if (!r.alive) return;
          await r.client.heartbeat(r.session, await agentRecords($)).catch(async (err: unknown) => {
            if (err instanceof HelmError && err.status === 404) await bind($, r);
          });
        })().catch(() => {});
      }),
    );
    return started;
  });

  on('session.end', async ($, e, next) => {
    const out = await next(e);
    const r = rt;
    if (!r) return out;
    if (e.reason === 'clear' || e.reason === 'resume') {
      // the process goes on under another session id, with no session.start
      r.timers.push($.clock.after(500, () => void bind($, r).catch(() => {})));
      return out;
    }
    r.alive = false;
    r.timers.forEach((t) => t.cancel());
    r.mailbox.stop();
    await r.client.end(e.sessionId).catch(() => {});
    return out;
  });

  on('turn.start', ($, e, next) => {
    rt?.mailbox.turnStarted();
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const out = await next(e);
    const r = rt;
    if (r?.alive) {
      if (e.agentId === undefined) await r.mailbox.turnEnded();
      else await r.mailbox.agentEnded(e.agentId);
    }
    return out;
  });

  for (const t of tools) {
    on('tool.call', { tool: `mcp__${PLUGIN}__${t.name}` }, async ($, e) => {
      const r = rt;
      if (!r) return { deny: 'helm is starting; call it again in a moment' };
      if (t.mainOnly && e.agentId !== undefined) return { deny: `helm ${t.name} is the session's own: report to whoever spawned you instead` };
      try {
        const text = await t.run(toolEnv(r), e as unknown as Record<string, unknown>, e.agentId, port());
        return { result: [{ type: 'text', text }] };
      } catch (err) {
        return { deny: `helm ${t.name}: ${(err as Error).message}` };
      }
    }).catch(() => ({ deny: `helm ${t.name} failed inside its hook` }));
  }

  on('command.run', { command: PLUGIN }, async ($, e) => {
    const r = rt;
    if (!r) return { text: 'helm is starting' };
    const [head = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean);
    try {
      if (head === 'role') {
        const role = rest[0] as SessionRole;
        if (!ROLES.includes(role)) return { text: 'usage: /helm role coordinator|repo|other [owner/name]' };
        const repo = rest[1] && isRepoName(rest[1]) ? rest[1] : r.repo;
        r.role = role;
        if (repo) r.repo = repo;
        await r.client.role(r.session, role, repo);
        return { text: `this session is now ${role}${repo && role === 'repo' ? ` for ${repo}` : ''}` };
      }
      if (head === 'web') {
        const url = (await r.client.health()).web ?? '';
        await $.process.run(['xdg-open', url]).catch(() => undefined);
        return { text: url };
      }
      if (head === 'restart') {
        await $.process.run(daemonArgv($, 'restart'), { timeoutMs: 30_000 });
        return { text: 'helmd restarted' };
      }
      return { text: await helpText(r) };
    } catch (err) {
      return { text: `helm: ${(err as Error).message}` };
    }
  });
};
