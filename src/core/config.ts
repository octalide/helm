import type { RoutingConfig } from './protocol.ts';
import type { RepoName, Tier } from './types.ts';
import { isEffort } from './protocol.ts';

export type Config = {
  // directories searched for checkouts of the polled repositories
  roots: string[];
  // repositories polled whether or not anything references them
  repos: RepoName[];
  web: { port: number };
  poll: {
    // seconds between polls of a repository with work, ci or a subscription in flight
    active: number;
    // seconds between polls of any other repository
    idle: number;
    // seconds between scans of local git state for an active repository
    local: number;
    // a pr head whose checks have not all finished in this many hours is raised as stalled
    stallHours: number;
    // a session whose heartbeat is this many seconds overdue is marked gone
    goneSeconds: number;
  };
  routing: RoutingConfig;
};

export const DEFAULT_TIERS: Tier[] = [
  {
    name: 'mechanical',
    model: 'claude-haiku-5-5',
    effort: 'high',
    when: 'mechanical changes with an obvious shape: version bumps, pin bumps, renames, moves, docs, data rows that follow an existing pattern, finishing a PR whose implementation is done (body, CI, ready), one-file fixes whose cause the issue already states',
  },
  {
    name: 'light',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    when: 'small contained work in one module with a stated design: a focused bug fix, a test addition, a catalog or table extension that needs some judgment',
  },
  {
    name: 'standard',
    model: 'claude-opus-5-5',
    effort: 'medium',
    when: 'ordinary feature or bug work inside one subsystem with clear acceptance criteria',
  },
  {
    name: 'deep',
    model: 'claude-opus-5-5',
    effort: 'high',
    when: 'changes that cross subsystems or public contracts, code generation, concurrency, memory layout, soundness, design-heavy work, or a bug whose root cause is not yet known',
  },
  {
    name: 'frontier',
    model: 'claude-fable-5-1',
    effort: 'high',
    when: 'reserved for extremely intelligence-heavy work where decisions have to be made: architecture, contract or language design, research-grade problems, or a problem earlier tiers failed on. Never for implementation that a lower tier can carry once the design is settled',
    judge: false,
  },
];

export const DEFAULT_CONFIG: Config = {
  roots: ['~/dev/src'],
  repos: [],
  web: { port: 7468 },
  poll: { active: 20, idle: 180, local: 15, stallHours: 1, goneSeconds: 120 },
  routing: { judge: 'claude-haiku-5-5', review: 0.7, tiers: DEFAULT_TIERS, fallback: 'standard' },
};

export type Layer = Partial<Omit<Config, 'web' | 'poll' | 'routing'>> & {
  web?: Partial<Config['web']>;
  poll?: Partial<Config['poll']>;
  routing?: Partial<RoutingConfig>;
};

// every field a layer can set, by its dotted path; tiers is one field, since tiers replace as a whole
export const FIELDS = ['roots', 'repos', 'web.port', 'poll.active', 'poll.idle', 'poll.local', 'poll.stallHours', 'poll.goneSeconds', 'routing.judge', 'routing.review', 'routing.fallback', 'routing.tiers'] as const;

export type Field = (typeof FIELDS)[number];

// fields a saved change reaches only once helmd restarts; helmd applies every other one as the file changes
export const RESTART_FIELDS: readonly Field[] = [];

// where each field's value comes from: the given layer when it sets the field, else the default
export function sourcesOf(layer: Layer): Record<Field, 'user' | 'default'> {
  const out = {} as Record<Field, 'user' | 'default'>;
  for (const f of FIELDS) {
    const [a, b] = f.split('.') as [keyof Layer, string | undefined];
    const v = layer[a] as Record<string, unknown> | undefined;
    out[f] = (b === undefined ? v : v?.[b]) === undefined ? 'default' : 'user';
  }
  return out;
}

// layers apply in order, field by field; tiers replace as a whole, since a partial tier table has no meaning
export function mergeConfig(base: Config, ...layers: unknown[]): Config {
  let out = base;
  for (const raw of layers) {
    const layer = checkLayer(raw);
    out = {
      roots: layer.roots ?? out.roots,
      repos: layer.repos ?? out.repos,
      web: { ...out.web, ...layer.web },
      poll: { ...out.poll, ...layer.poll },
      routing: { ...out.routing, ...layer.routing },
    };
  }
  const { tiers, fallback } = out.routing;
  if (!tiers.length) throw new Error('routing.tiers is empty');
  const back = tiers.find((t) => t.name === fallback);
  if (!back) throw new Error(`routing.fallback ${JSON.stringify(fallback)} names no tier; the tiers are ${tiers.map((t) => t.name).join(', ')}`);
  // the judge falls back to it, so it has to be a tier the judge may pick
  if (back.judge === false) throw new Error(`routing.fallback ${JSON.stringify(fallback)} is caller-only (judge: false)`);
  return out;
}

// a repository's own .helm/config.json may only change routing: what is polled and where is the machine's
export function repoLayer(raw: unknown): Layer {
  const layer = checkLayer(raw);
  return layer.routing === undefined ? {} : { routing: layer.routing };
}

export function checkLayer(raw: unknown): Layer {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new Error('config must be a json object');
  const layer = raw as Layer;
  if (layer.roots !== undefined && !isStrings(layer.roots)) throw new Error('roots must be a list of paths');
  if (layer.repos !== undefined && (!isStrings(layer.repos) || layer.repos.some((r) => !/^[^/\s]+\/[^/\s]+$/.test(r)))) {
    throw new Error('repos must be a list of owner/name');
  }
  for (const key of ['web', 'poll', 'routing'] as const) if (layer[key] !== undefined && !isObject(layer[key])) throw new Error(`${key} must be a json object`);
  const port = layer.web?.port;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('web.port must be a port number, 1 to 65535');
  for (const [k, v] of Object.entries(layer.poll ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`poll.${k} must be a number above 0`);
  }
  const r = layer.routing ?? {};
  if (r.judge !== undefined && !nonEmpty(r.judge)) throw new Error('routing.judge must name a model');
  if (r.review !== undefined && !(typeof r.review === 'number' && r.review >= 0 && r.review <= 1)) throw new Error('routing.review must be a number from 0 to 1');
  if (r.fallback !== undefined && !nonEmpty(r.fallback)) throw new Error('routing.fallback must name a tier');
  if (r.tiers !== undefined && !Array.isArray(r.tiers)) throw new Error('routing.tiers must be a list');
  const names = new Set<string>();
  for (const tier of r.tiers ?? []) {
    if (!isObject(tier) || !nonEmpty(tier.name) || !nonEmpty(tier.model) || typeof tier.when !== 'string' || !isEffort(tier.effort)) {
      throw new Error(`routing tier ${JSON.stringify(tier)} needs name, model, effort and when`);
    }
    if (tier.judge !== undefined && typeof tier.judge !== 'boolean') throw new Error(`routing tier ${tier.name}: judge must be true or false`);
    if (names.has(tier.name)) throw new Error(`routing tier ${tier.name} is named twice`);
    names.add(tier.name);
  }
  return layer;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
