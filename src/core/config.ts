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
  },
];

export const DEFAULT_CONFIG: Config = {
  roots: ['~/dev/src'],
  repos: [],
  web: { port: 7468 },
  poll: { active: 20, idle: 180, local: 15, stallHours: 1, goneSeconds: 120 },
  routing: { judge: 'claude-haiku-5-5', review: 0.7, tiers: DEFAULT_TIERS, fallback: 'standard' },
};

type Layer = Partial<Omit<Config, 'web' | 'poll' | 'routing'>> & {
  web?: Partial<Config['web']>;
  poll?: Partial<Config['poll']>;
  routing?: Partial<RoutingConfig>;
};

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
  const fallback = out.routing.tiers.find((t) => t.name === out.routing.fallback) ?? out.routing.tiers[0];
  if (!fallback) throw new Error('routing.tiers is empty');
  return { ...out, routing: { ...out.routing, fallback: fallback.name } };
}

// a repository's own .helm/config.json may only change routing: what is polled and where is the machine's
export function repoLayer(raw: unknown): Layer {
  const layer = checkLayer(raw);
  return layer.routing === undefined ? {} : { routing: layer.routing };
}

function checkLayer(raw: unknown): Layer {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a json object');
  const layer = raw as Layer;
  if (layer.roots !== undefined && !isStrings(layer.roots)) throw new Error('roots must be a list of paths');
  if (layer.repos !== undefined && (!isStrings(layer.repos) || layer.repos.some((r) => !/^[^/\s]+\/[^/\s]+$/.test(r)))) {
    throw new Error('repos must be a list of owner/name');
  }
  for (const tier of layer.routing?.tiers ?? []) {
    if (!tier || typeof tier.name !== 'string' || typeof tier.model !== 'string' || typeof tier.when !== 'string' || !isEffort(tier.effort)) {
      throw new Error(`routing tier ${JSON.stringify(tier)} needs name, model, effort and when`);
    }
  }
  return layer;
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
