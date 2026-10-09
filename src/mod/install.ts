import { compareVersions } from '../core/repo.ts';

// one copy of helm on the machine: where it is, its version, and the protocol its helmd speaks
export type Install = { root: string; name: string; version: string; protocol: number };

export type InstallFs = { dirs: (path: string) => Promise<string[]>; read: (path: string) => Promise<string> };

type Manifest = { name?: unknown; version?: unknown; helm?: { protocol?: unknown } };

// what a package.json says of the install at root, when it declares the protocol its helmd speaks
export function installOf(root: string, text: string): Install | undefined {
  let m: Manifest;
  try {
    m = JSON.parse(text) as Manifest;
  } catch {
    return undefined;
  }
  const protocol = m.helm?.protocol;
  if (typeof m.name !== 'string' || typeof m.version !== 'string' || typeof protocol !== 'number') return undefined;
  return { root, name: m.name, version: m.version, protocol };
}

// the helmd a mod starts: the newest install beside its own that speaks its protocol. the plugin cache keeps every
// installed version side by side, each in a directory named for it; a root laid out otherwise (a dev checkout,
// --plugin-dir) has only itself
export async function newestInstall(own: Install, fs: InstallFs): Promise<Install> {
  const root = own.root.replace(/\/+$/, '');
  const cut = root.lastIndexOf('/');
  if (cut <= 0 || root.slice(cut + 1) !== own.version) return own;
  const parent = root.slice(0, cut);
  let best = own;
  for (const name of await fs.dirs(parent).catch(() => [])) {
    if (!/^\d+\.\d+\.\d+/.test(name) || compareVersions(name, best.version) <= 0) continue;
    const text = await fs.read(`${parent}/${name}/package.json`).catch(() => undefined);
    const it = text === undefined ? undefined : installOf(`${parent}/${name}`, text);
    if (it && it.name === own.name && it.version === name && it.protocol === own.protocol) best = it;
  }
  return best;
}
