import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';
import { helmPaths, type PathEnv } from '../src/core/paths.ts';
import { PROTOCOL, type StreamFrame } from '../src/core/protocol.ts';
import { compareVersions, isRepoName, repoOfRemote } from '../src/core/repo.ts';
import type { AgentRecord, AgentStatus, Effort, Fleet, RepoName, SessionRole } from '../src/core/types.ts';
import { HelmClient, HelmError } from '../src/mod/client.ts';
import { type DispatchPort, dispatchTool, issueAgentName } from '../src/mod/dispatch.ts';
import { Mailbox } from '../src/mod/mailbox.ts';
import { type Tool, TOOLS } from '../src/mod/tools.ts';
import { bandRow, isTab, paneRows, type Row, type Self, statusText, type Tab } from '../src/mod/view.ts';
import { PLUGIN, ROLES, type Runtime, toolEnv } from './runtime.ts';

type $ = EngineInterface;

// what a tool that reaches the engine is handed: plain functions over $, built here per call
type Port = DispatchPort;

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 3_000;
// the pane redraws from helmd at most this often, however fast changes come
const REFRESH_MS = 1_500;
const PANE = 'helm';

// the fleet itself stays in the module, since the state contract holds only self-contained data; the atom is the
// stamp that tells a drawing to read it again
// the role prompts, read at session start: the coordinator's, and the repository session's with {{repo}} in it
let rolePrompts: { coordinator: string; repo: string } | undefined;

function rolePrompt(r: Runtime): string | undefined {
  if (!rolePrompts) return undefined;
  if (r.role === 'coordinator') return rolePrompts.coordinator;
  if (r.role === 'repo') return rolePrompts.repo.replaceAll('{{repo}}', r.repo ?? 'its repository');
  return undefined;
}

const fleetAt = atom({ plugin: 'helm', key: 'fleetAt' } as const, 0);
const paneTab = atom({ plugin: 'helm', key: 'paneTab' } as const, 'work' as Tab);
let fleet: Fleet | undefined;

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

// issue agent types registered by this load of the module, by name
const issueTypes = new Set<string>();
let issuePrompt: string | undefined;

async function issueAgentType($: $, model: string, effort: Effort): Promise<string> {
  const name = issueAgentName(model, effort);
  if (!issueTypes.has(name)) {
    issuePrompt ??= await $.fs.read(`${$.plugin.root}/prompts/issue.md`);
    await $.agent.register({
      name,
      description: `Implements one GitHub issue to a merge-ready PR on ${model} at ${effort} effort. Started by helm dispatch only.`,
      prompt: issuePrompt,
      model,
      effort,
      disallowedTools: ['AskUserQuestion'],
    });
    issueTypes.add(name);
  }
  return `${PLUGIN}:${name}`;
}

// every tier this session can route to, plus the model and effort of every work item it owns, registered up front so a
// dispatch in its first turn finds them and an agent on a tier since removed can still be resumed
async function registerTiers($: $, client: HelmClient, repo: RepoName | undefined, session: string): Promise<void> {
  const { routing } = await client.config(repo);
  for (const t of routing.tiers) await issueAgentType($, t.model, t.effort);
  const { work } = await client.fleet(true);
  for (const w of work) if (w.owner === session && w.routing) await issueAgentType($, w.routing.model, w.routing.effort);
}

function port($: $): Port {
  return {
    now: Date.now,
    agentType: (model, effort) => issueAgentType($, model, effort),
    spawn: async (a) => {
      const r = await $.agent.spawn(a);
      return r.deny !== undefined ? { deny: r.deny } : r.agentId ? { agentId: r.agentId } : {};
    },
    complete: async (a) => {
      const r = await $.model.complete({ ...a, maxTokens: 400, effort: 'low', timeoutMs: 45_000 });
      return r.isAnswered ? { text: r.text } : { failed: r.reason };
    },
  };
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
          if (line) await frame($, r, JSON.parse(line) as StreamFrame);
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

async function frame($: $, r: Runtime, f: StreamFrame): Promise<void> {
  if (f.type === 'letter') await r.mailbox.receive(f.letter);
  if (f.type === 'changed' || f.type === 'hello') refresh($, r);
}

const selfOf = (r: Runtime): Self => ({ session: r.session, role: r.role, ...(r.repo ? { repo: r.repo } : {}) });

let refreshTimer: { cancel: () => void } | undefined;
let lastRefresh = 0;

// the fleet for the pane, band and status line, read once per window however many changes land in it
function refresh($: $, r: Runtime): void {
  if (refreshTimer || !r.alive) return;
  const wait = Math.max(0, lastRefresh + REFRESH_MS - Date.now());
  refreshTimer = $.clock.after(wait, () => {
    refreshTimer = undefined;
    lastRefresh = Date.now();
    void (async () => {
      const f = await r.client.fleet(true);
      fleet = f;
      await update($, fleetAt, () => f.at);
      $.ui.status(statusText(f, selfOf(r)));
    })().catch((e: Error) => $.ui.log(`helm: refresh failed: ${e.message}`, { to: 'debug' }));
  });
}

// a row of plain segments is one line of text; a row holding a control lays its segments out side by side, each
// control a Button whose press the ui.press hook routes by its key
function rowsOf($: $, e: Parameters<$['ui']['resolve']>[0], rows: Row[]) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const text = (s: Row[number]) => <Text {...(s.color ? { color: s.color } : {})} dimColor={s.dim ?? false} bold={s.bold ?? false}>{s.text}</Text>;
  return (
    <Box flexDirection="column">
      {rows.map((row) =>
        row.some((s) => s.press) ? (
          <Box flexDirection="row">
            {row.map((s) =>
              s.press ? (
                <Button key={s.press} {...(s.boxed ? {} : { plain: true as const })} {...(s.hotkey ? { hotkey: s.hotkey } : {})} dimColor={s.dim ?? false} onPress={() => {}}>
                  {text(s)}
                </Button>
              ) : (
                text(s)
              ),
            )}
          </Box>
        ) : (
          <Text wrap="truncate-end">{row.length ? row.map(text) : ' '}</Text>
        ),
      )}
    </Box>
  );
}

async function helpText(r: Runtime): Promise<string> {
  const h = await r.client.health().catch(() => undefined);
  return [
    `helm ${r.version} · session ${r.session} · role ${r.role}${r.repo ? ` · ${r.repo}` : ''}`,
    h ? `helmd ${h.version} pid ${h.pid} · ${h.web ?? ''}` : 'helmd not answering',
    'commands: /helm pane · /helm role coordinator|repo|other [owner/name] · /helm web · /helm restart',
  ].join('\n');
}

export const register: Register = (on) => {
  const tools: Tool<Port>[] = [...TOOLS, dispatchTool()];

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
    rolePrompts = { coordinator: await $.fs.read(`${$.plugin.root}/prompts/coordinator.md`), repo: await $.fs.read(`${$.plugin.root}/prompts/repo.md`) };
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
      r.web = (await client.health()).web;
      issueTypes.clear();
      await registerTiers($, client, repo, r.session).catch((err: Error) => $.ui.log(`helm: issue agents not registered: ${err.message}`));
    } catch (err) {
      $.ui.log(`helm: ${(err as Error).message}`);
    }
    pump($, r);
    if (r.role !== 'other') void $.ui.open({ id: PANE, title: 'helm' });
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
        const text = await t.run(toolEnv(r), e as unknown as Record<string, unknown>, e.agentId, port($));
        return { result: [{ type: 'text', text }] };
      } catch (err) {
        return { deny: `helm ${t.name}: ${(err as Error).message}` };
      }
    }).catch(() => ({ deny: `helm ${t.name} failed inside its hook` }));
  }

  // a repository session and a coordinator each read how helm works in their role, so no instruction file has to
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e);
    const text = rt ? rolePrompt(rt) : undefined;
    return text ? { sections: [...out.sections, { id: `${PLUGIN}:role`, text, scope: 'session' as const }] } : out;
  });

  // issue agents start through dispatch, which claims and routes them; the model never picks one itself
  on('agent.offer', ($, e, next) => (e.agent.startsWith(`${PLUGIN}:issue-`) ? { isOffered: false } : next(e))).catch(($, e, next) => next(e));

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const r = rt;
    await read($, fleetAt);
    const tab = await read($, paneTab);
    const f = fleet;
    const { Text } = $.ui.resolve(e);
    if (!r || !f) return <Text dimColor>helm is connecting to helmd</Text>;
    return rowsOf($, e, paneRows(f, selfOf(r), { rows: Math.max(6, (e.viewport?.rows ?? 24) - 2), cols: e.viewport?.columns ?? 80, tab, ...(r.web ? { web: r.web } : {}) }));
  });

  // the pane's controls: a tab, an option that answers a decision, or a dismissal
  on('ui.press', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const r = rt;
    const [kind, id, index] = e.element.split(':');
    if (kind === 'tab' && isTab(id)) await update($, paneTab, () => id);
    if (r && id && kind === 'answer') {
      const option = fleet?.decisions.find((d) => d.id === id)?.options?.[Number(index)];
      if (option) await r.client.answer(id, { text: '', option, by: 'pane' }).then(() => refresh($, r), (err: Error) => $.ui.log(`helm: answer failed: ${err.message}`, { to: 'debug' }));
    }
    if (r && id && kind === 'dismiss') await r.client.dismiss(id).then(() => refresh($, r), (err: Error) => $.ui.log(`helm: dismiss failed: ${err.message}`, { to: 'debug' }));
    return next(e);
  }).catch(($, e, next) => next(e));

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = rt;
    await read($, fleetAt);
    const f = fleet;
    const band = r && f && !e.props.hasSurvey ? bandRow(f, selfOf(r)) : undefined;
    if (!band) return next(e);
    const { Box } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {await next(e)}
        {rowsOf($, e, [band])}
      </Box>
    );
  });

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
      if (head === 'pane') {
        const opened = await $.ui.open({ id: PANE, title: 'helm', focus: true });
        refresh($, r);
        return { text: opened.isPlaced ? 'helm pane open' : `helm pane waits: ${opened.reason}` };
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
