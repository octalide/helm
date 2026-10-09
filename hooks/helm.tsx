import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';
import { helmPaths, type PathEnv } from '../src/core/paths.ts';
import { daemonAction, PROTOCOL, type StreamFrame } from '../src/core/protocol.ts';
import { isRepoName, repoOfRemote } from '../src/core/repo.ts';
import type { AgentRecord, AgentStatus, Effort, Fleet, RepoName, SessionRole } from '../src/core/types.ts';
import { HelmClient, HelmError } from '../src/mod/client.ts';
import { type Install, newestInstall } from '../src/mod/install.ts';
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
// the module instance that holds the session's binding. a reload swaps the hooks but can leave the replaced
// instance's stream running, its mailbox deaf to turns, so each instance stamps itself here at session.start and
// one that finds another stamp stands down
const binder = atom({ plugin: 'helm', key: 'binder' } as const, '');
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

function daemonArgv(root: string, cmd: string, ...rest: string[]): string[] {
  return ['node', '--disable-warning=ExperimentalWarning', `${root}/src/daemon/main.ts`, cmd, ...rest];
}

// the install whose helmd this mod starts or replaces helmd with, read again each time, since a newer one can be
// installed while the session runs
function daemonInstall($: $, own: Install): Promise<Install> {
  return newestInstall(own, {
    dirs: async (path) => (await $.fs.list(path)).filter((e) => e.kind === 'dir').map((e) => e.name),
    read: (path) => $.fs.read(path),
  });
}

let reloadSaid = false;

// helmd answering at the newest installed version or newer; an older one is replaced, a newer one is used as it is
async function ensureDaemon($: $, client: HelmClient, own: Install): Promise<void> {
  const up = await client.health().catch(() => undefined);
  const install = await daemonInstall($, own);
  const cmd = daemonAction(up, install.version);
  if (cmd === 'use') return;
  if (cmd === 'reload') {
    if (!reloadSaid) $.ui.log(`helm: helmd ${up?.version} speaks protocol ${up?.protocol}, newer than this session's mod (${PROTOCOL}): run /reload-plugins`);
    reloadSaid = true;
    return;
  }
  const r = await $.process.run(daemonArgv(install.root, cmd), { timeoutMs: 30_000 });
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

// from: the session this process went on from, which helmd hands over to this one whole. the role goes only when one
// was asked for, and the role and repository are what helmd answers, which keeps a known session's own
async function bind($: $, r: Runtime, from?: string): Promise<void> {
  r.session = await $.session.id();
  const s = await r.client.register({
    id: r.session,
    cwd: await $.session.cwd(),
    protocol: PROTOCOL,
    ...(r.asked ? { role: r.asked } : {}),
    ...(r.checkout ? { repo: r.checkout } : {}),
    ...(from && from !== r.session ? { from } : {}),
  });
  r.role = s.role;
  if (s.repo) r.repo = s.repo;
  else delete r.repo;
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

// false once a later instance of this module holds the binding, which this one learns of here and stands down for:
// its timers and mailbox stop, and the stream it reads ends. a stamp that cannot be read is another's
async function holds($: $, r: Runtime): Promise<boolean> {
  if (!r.alive) return false;
  const stamp = await read($, binder).catch(() => undefined);
  if (stamp === '' || stamp === r.instance) return true;
  r.alive = false;
  r.timers.forEach((t) => t.cancel());
  r.mailbox.stop();
  $.ui.log(`helm: instance ${r.instance} stood down for ${stamp ?? 'an unreadable binding'}`, { to: 'debug' });
  return false;
}

// letters and change notices from helmd, for the life of this module; reconnects whenever helmd goes away
function pump($: $, r: Runtime): void {
  const run = async () => {
    try {
      let buf = '';
      const session = r.session;
      // a stream reads one session's letters: once the process goes on under another id, it is opened again for that one
      for await (const piece of $.process.spawn({ argv: daemonArgv(r.install.root, 'stream', session) })) {
        if (!(await holds($, r)) || r.session !== session) break;
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
    if (!(await holds($, r))) return;
    r.timers.push(
      $.clock.after(RECONNECT_MS, () => {
        void ensureDaemon($, r.client, r.install)
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
    const text = await r.mailbox.attach(e.agentId).catch(() => undefined);
    return text === undefined ? out : { ...out, context: [...(out.context ?? []), text] };
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
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/package.json`)) as { name: string; version: string };
    const install: Install = { root: $.plugin.root, name: manifest.name, version: manifest.version, protocol: PROTOCOL };
    const repo = await sessionRepo($);
    const env = (await $.env.get('HELM_ROLE')) as SessionRole | undefined;
    const asked = env && ROLES.includes(env) ? env : undefined;
    const r: Runtime = {
      client,
      version: install.version,
      install,
      home: (await $.env.get('HOME')) ?? '',
      session: await $.session.id(),
      // until helmd answers
      role: asked ?? 'other',
      ...(asked ? { asked } : {}),
      ...(repo ? { checkout: repo } : {}),
      instance: crypto.randomUUID(),
      alive: true,
      timers: [],
      ...(repo ? { repo } : {}),
      mailbox: new Mailbox({
        now: Date.now,
        take: (id) => client.take(id),
        submit: async (text) => (await $.prompt.submit({ text })).drop === undefined,
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
    await update($, binder, () => r.instance);

    for (const t of tools) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: !t.eager });
    await $.command.register({ name: PLUGIN, description: 'helm: status, role, web page' });
    try {
      await ensureDaemon($, client, install);
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
          if (!(await holds($, r))) return;
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
      // the process goes on under another session id, with no session.start, and this instance keeps the binding; the
      // new id takes over what the ended one held
      await update($, binder, () => r.instance).catch(() => {});
      r.timers.push($.clock.after(500, () => void bind($, r, e.sessionId).catch(() => {})));
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

  // issue agents start through dispatch, which claims and routes them, so the model never starts one itself. the guard is
  // on the spawn, not the offer: an offer is also asked when a message resumes an agent, and refusing it strands the agent
  on('agent.spawn', ($, e, next) =>
    e.subagentType.startsWith(`${PLUGIN}:issue-`) && next.origin.plugin !== PLUGIN ? { deny: 'issue agents start through mcp__helm__dispatch, which claims and routes the issue' } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'the helm spawn guard failed' }));

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const r = rt;
    await read($, fleetAt);
    const tab = await read($, paneTab);
    const f = fleet;
    const { Text } = $.ui.resolve(e);
    if (!r || !f) return <Text dimColor>helm is connecting to helmd</Text>;
    return rowsOf($, e, paneRows(f, selfOf(r), { rows: Math.max(6, (e.viewport?.rows ?? 24) - 2), cols: e.viewport?.columns ?? 80, tab, ...(r.web ? { web: r.web } : {}) }));
  });

  // the pane's controls: a tab, an option that answers a decision, an escalation to the person, or a dismissal
  on('ui.press', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const r = rt;
    const [kind, id, index] = e.element.split(':');
    if (kind === 'tab' && isTab(id)) await update($, paneTab, () => id);
    if (r && id && kind === 'answer') {
      const option = fleet?.decisions.find((d) => d.id === id)?.options?.[Number(index)];
      if (option) await r.client.answer(id, { text: '', option, by: 'pane' }).then(() => refresh($, r), (err: Error) => $.ui.log(`helm: answer failed: ${err.message}`, { to: 'debug' }));
    }
    if (r && id && kind === 'escalate') await r.client.escalate(id, { by: 'pane' }).then(() => refresh($, r), (err: Error) => $.ui.log(`helm: escalate failed: ${err.message}`, { to: 'debug' }));
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
        const s = await r.client.role(r.session, role, repo);
        r.asked = s.role;
        r.role = s.role;
        if (s.repo) r.repo = s.repo;
        return { text: `this session is now ${s.role}${s.repo && s.role === 'repo' ? ` for ${s.repo}` : ''}` };
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
        const res = await $.process.run(daemonArgv((await daemonInstall($, r.install)).root, 'restart'), { timeoutMs: 30_000 });
        if (res.exitCode !== 0) throw new Error(`helmd restart failed: ${(res.stderr || res.stdout).trim()}`);
        return { text: 'helmd restarted' };
      }
      return { text: await helpText(r) };
    } catch (err) {
      return { text: `helm: ${(err as Error).message}` };
    }
  });
};
