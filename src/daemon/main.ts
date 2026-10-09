import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// one daemon per user: the lock holds the live pid, and a lock whose pid is dead is taken over
function lock(paths: HelmPaths): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(paths.lock, 'utf8') === String(process.pid)) unlinkSync(paths.lock);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(paths.lock, 'utf8'));
      if (pid && alive(pid)) throw new Error(`helmd already runs as pid ${pid}`);
      unlinkSync(paths.lock);
    }
  }
  throw new Error(`could not take ${paths.lock}`);
}

async function serve(paths: HelmPaths): Promise<void> {
  await mkdir(dirname(paths.socket), { recursive: true, mode: 0o700 });
  await mkdir(paths.state, { recursive: true });
  await mkdir(dirname(paths.lock), { recursive: true, mode: 0o700 });
  const release = lock(paths);
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
  await daemon.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    socket.close();
    web?.close();
    await daemon.stop();
    try {
      unlinkSync(paths.socket);
    } catch {}
    release();
    process.exit(0);
  };
  const table = routes(daemon, () => void stop());
  try {
    unlinkSync(paths.socket);
  } catch {}
  const socket = createServer(handler(table, { web: false }));
  await listen(socket, paths.socket);
  await serveWeb(config.web.port);
  setInterval(() => daemon.ping(), 20_000);
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  log(`helmd ${VERSION} on ${paths.socket}${web ? ` and http://127.0.0.1:${config.web.port}/` : ''}`);
}

// starts a detached daemon unless one answers, and waits until it does
async function start(paths: HelmPaths): Promise<Health> {
  const up = await health(paths);
  if (up) return up;
  await mkdir(paths.state, { recursive: true });
  const out = openSync(paths.daemonLog, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'main.ts'), 'serve'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  closeSync(out);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const h = await health(paths);
    if (h) return h;
  }
  throw new Error(`helmd did not answer on ${paths.socket}; see ${paths.daemonLog}`);
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
    case 'serve':
      return serve(paths);
    case 'start':
      console.log(JSON.stringify(await start(paths)));
      return;
    case 'stop':
      console.log((await stopDaemon(paths)) ? 'stopped' : 'not running');
      return;
    case 'restart':
      await stopDaemon(paths);
      console.log(JSON.stringify(await start(paths)));
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
