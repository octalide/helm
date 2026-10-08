export type PathEnv = {
  HOME: string;
  XDG_RUNTIME_DIR?: string;
  XDG_STATE_HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
  HELM_SOCKET?: string;
  HELM_HOME?: string;
};

export type HelmPaths = {
  socket: string;
  state: string;
  config: string;
  cache: string;
  ledger: string;
  repos: string;
  logs: string;
  lock: string;
  daemonLog: string;
};

// where helmd keeps everything, resolved the same way by the daemon and by every session's mod. HELM_HOME puts it
// all under one directory, for tests and for running a second daemon beside the real one
export function helmPaths(env: PathEnv): HelmPaths {
  const root = env.HELM_HOME;
  const state = root ? `${root}/state` : `${env.XDG_STATE_HOME || `${env.HOME}/.local/state`}/helm`;
  const config = root ? `${root}/config` : `${env.XDG_CONFIG_HOME || `${env.HOME}/.config`}/helm`;
  const cache = root ? `${root}/cache` : `${env.XDG_CACHE_HOME || `${env.HOME}/.cache`}/helm`;
  const runtime = root ? `${root}/run` : env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/helm` : `${state}/run`;
  return {
    socket: env.HELM_SOCKET || `${runtime}/helmd.sock`,
    state,
    config,
    cache,
    ledger: `${state}/ledger.json`,
    repos: `${state}/repos`,
    logs: `${cache}/logs`,
    lock: `${runtime}/helmd.lock`,
    daemonLog: `${state}/helmd.log`,
  };
}
