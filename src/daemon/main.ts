import { spawn } from 'node:child_process';
import { closeSync, linkSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { helmPaths, type HelmPaths } from '../core/paths.ts';
import type { Health } from '../core/protocol.ts';
import { GitHub } from './github.ts';
import { Daemon, readConfig } from './helmd.ts';
import { createServer, handler, listen, routes } from './server.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

function call<T>(paths: HelmPaths, method: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: paths.socket, path, method, timeout: 3000 }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(text) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const health = (paths: HelmPaths) => call<Health>(paths, 'GET', '/v1/health').catch(() => undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DRAIN_MS = 200;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// takes a file that holds a live pid, creating it, or over a dead pid
function claim(path: string, held: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8'));
      if (pid && alive(pid)) throw new Error(`${held} pid ${pid}`);
      unlinkSync(path);
    }
  }
  throw new Error(`could not take ${path}`);
}

// one daemon per user: the lock holds the live pid, and a lock whose pid is dead is taken over. a successor takes it
// from the daemon it replaces while that one still runs, so the lock never stands empty across the swap and no other
// helmd starts in between; a daemon releases the lock only while it still holds its pid
function lock(paths: HelmPaths, replacing?: number): () => void {
  if (replacing === undefined) claim(paths.lock, 'helmd already runs as');
  else {
    claim(`${paths.lock}.next`, 'helmd is being replaced by');
    try {
      let pid = 0;
      try {
        pid = Number(readFileSync(paths.lock, 'utf8'));
      } catch {}
      if (pid !== replacing && pid && alive(pid)) throw new Error(`helmd already runs as pid ${pid}`);
      writeFileSync(paths.lock, String(process.pid));
    } finally {
      unlinkSync(`${paths.lock}.next`);
    }
  }
  return () => {
    try {
      if (readFileSync(paths.lock, 'utf8') === String(process.pid)) unlinkSync(paths.lock);
    } catch {}
  };
}

// a daemon listens on a name of its own and links the socket path to it, so a successor can take the path over in
// one rename while this one still answers, and closing this listener removes only its own name
async function bindSocket(paths: HelmPaths, server: ReturnType<typeof createServer>): Promise<{ publish: () => void; ours: () => boolean }> {
  const own = `${paths.socket}.${process.pid}`;
  const dir = dirname(paths.socket);
  const base = basename(paths.socket);
  // names left by daemons that died without closing
  for (const name of readdirSync(dir)) {
    const m = name.startsWith(`${base}.`) ? /^(\d+)(\.next)?$/.exec(name.slice(base.length + 1)) : null;
    if (m && (Number(m[1]) === process.pid || !alive(Number(m[1])))) {
      try {
        unlinkSync(join(dir, name));
      } catch {}
    }
  }
  await listen(server, own);
  const { dev, ino } = statSync(own);
  const ours = () => {
    try {
      const s = statSync(paths.socket);
      return s.dev === dev && s.ino === ino;
    } catch {
      return false;
    }
  };
  const publish = () => {
    if (ours()) return;
    const next = `${own}.next`;
    try {
      unlinkSync(next);
    } catch {}
    linkSync(own, next);
    renameSync(next, paths.socket);
  };
  return { publish, ours };
}

// replacing: the pid of the daemon this one takes over from. it takes the lock, then the socket path, answering
// health at once and holding every other request until the old daemon has saved and gone, so health never fails
async function serve(paths: HelmPaths, replacing?: number): Promise<void> {
  await mkdir(dirname(paths.socket), { recursive: true, mode: 0o700 });
  await mkdir(paths.state, { recursive: true });
  await mkdir(dirname(paths.lock), { recursive: true, mode: 0o700 });
  const release = lock(paths, replacing);
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const config = await readConfig(paths);
  let web: ReturnType<typeof createServer> | undefined;
  let moving = Promise.resolve();
  // the page moves with web.port, live: the old listener closes once the new one is up, one move at a time
  const serveWeb = (port: number): Promise<void> => (moving = moving.then(() => bindWeb(port)));
  const bindWeb = async (port: number): Promise<void> => {
    const next = createServer(handler(table, { web: true, port, static: join(ROOT, 'web') }));
    try {
      await listen(next, { port, host: '127.0.0.1' });
    } catch (e) {
      log(`web page not served on ${port}: ${(e as Error).message}`);
      return;
    }
    web?.close();
    web = next;
  };
  const daemon = new Daemon({
    paths,
    config,
    gh: new GitHub(),
    version: VERSION,
    log,
    onConfig: (next, prev) => {
      if (next.web.port !== prev.web.port) void serveWeb(next.web.port);
    },
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    socket.close();
    web?.close();
    await daemon.stop();
    try {
      if (bound.ours()) unlinkSync(paths.socket);
    } catch {}
    release();
    process.exit(0);
  };
  const table = routes(daemon, () => void stop());
  let ready = () => {};
  const started = new Promise<void>((r) => (ready = r));
  const socket = createServer(handler(table, { web: false, ready: started }));
  const bound = await bindSocket(paths, socket);
  bound.publish();
  if (replacing !== undefined) await retire(replacing, bound.publish, log);
  await daemon.start();
  ready();
  await serveWeb(config.web.port);
  setInterval(() => daemon.ping(), 20_000);
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  log(`helmd ${VERSION} on ${paths.socket}${web ? ` and http://127.0.0.1:${config.web.port}/` : ''}`);
}

// stops the daemon being replaced and waits for it to go, keeping the socket path on this one meanwhile: a daemon
// older than this handover removes the path by name as it stops. it is stopped only once it has had time to answer
// what reached it before the path moved, since a connection still waiting to be accepted dies with its listener
async function retire(pid: number, publish: () => void, log: (line: string) => void): Promise<void> {
  await sleep(DRAIN_MS);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  const deadline = Date.now() + 10_000;
  let killed = false;
  while (alive(pid) && Date.now() < deadline + 2_000) {
    publish();
    if (!killed && Date.now() > deadline) {
      log(`helmd ${pid} did not stop; killing it`);
      killed = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await sleep(1);
  }
  publish();
}

async function spawnServe(paths: HelmPaths, ...args: string[]): Promise<void> {
  await mkdir(paths.state, { recursive: true });
  const out = openSync(paths.daemonLog, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'main.ts'), 'serve', ...args], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  closeSync(out);
}

// waits for a daemon to answer, other than the one being replaced
async function answered(paths: HelmPaths, not?: number): Promise<Health> {
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const h = await health(paths);
    if (h && h.pid !== not) return h;
  }
  throw new Error(`helmd did not answer on ${paths.socket}; see ${paths.daemonLog}`);
}

// starts a detached daemon unless one answers, and waits until it does
async function start(paths: HelmPaths): Promise<Health> {
  const up = await health(paths);
  if (up) return up;
  await spawnServe(paths);
  return answered(paths);
}

// replaces the daemon that answers with one of this version, which takes over before the old one stops
async function restart(paths: HelmPaths): Promise<Health> {
  const up = await health(paths);
  if (!up) return start(paths);
  await spawnServe(paths, '--replace', String(up.pid));
  return answered(paths, up.pid);
}

async function stopDaemon(paths: HelmPaths): Promise<boolean> {
  if (!(await health(paths))) return false;
  await call(paths, 'POST', '/v1/shutdown').catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!(await health(paths))) return true;
  }
  throw new Error('helmd did not stop');
}

// a session's letters and change notices as ndjson on stdout, until the daemon goes away; the mod reads it, since a
// hooks module holds no socket of its own
function stream(paths: HelmPaths, session: string | undefined): Promise<void> {
  if (!session) throw new Error('usage: helmd stream <session>');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: paths.socket, path: `/v1/sessions/${encodeURIComponent(session)}/stream` }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream refused: http ${res.statusCode}`));
      res.pipe(process.stdout);
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const paths = helmPaths(process.env as never);
  const cmd = process.argv[2] ?? 'status';
  switch (cmd) {
    case 'serve': {
      const replacing = process.argv[3] === '--replace' ? Number(process.argv[4]) : undefined;
      if (replacing !== undefined && !(Number.isInteger(replacing) && replacing > 0)) throw new Error('usage: helmd serve [--replace <pid>]');
      return serve(paths, replacing);
    }
    case 'start':
      console.log(JSON.stringify(await start(paths)));
      return;
    case 'stop':
      console.log((await stopDaemon(paths)) ? 'stopped' : 'not running');
      return;
    case 'restart':
      console.log(JSON.stringify(await restart(paths)));
      return;
    case 'status': {
      const h = await health(paths);
      console.log(h ? JSON.stringify(h) : 'not running');
      process.exitCode = h ? 0 : 1;
      return;
    }
    case 'stream':
      return stream(paths, process.argv[3]);
    case 'version':
      console.log(VERSION);
      return;
    default:
      console.error('usage: helmd serve|start|stop|restart|status|stream <session>|version');
      process.exitCode = 2;
  }
}

main().catch((e: Error) => {
  console.error(`helmd: ${e.message}`);
  process.exit(1);
});
