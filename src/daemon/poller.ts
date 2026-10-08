import { isDone, verdictOf } from '../core/checks.ts';
import type { ForgeState, HelmEvent, Run } from '../core/types.ts';
import { type CiMemory, diffForge, emptyMemory } from './events.ts';
import { fromJobs, fromRuns, fromSnapshot, type RestJobs, type RestRuns, SNAPSHOT_QUERY, type Snapshot } from './forge.ts';
import type { GitHub } from './github.ts';

export const CACHE_VERSION = 1;

// what a repository's poller keeps across restarts
export type RepoCache = {
  version: number;
  forge?: ForgeState;
  memory: CiMemory;
  // ref name -> whether it is a tag, looked up once
  tags: Record<string, boolean>;
  snapshotAt?: number;
};

export const emptyCache = (): RepoCache => ({ version: CACHE_VERSION, memory: emptyMemory(), tags: {} });

export type PollResult = { changed: boolean; events: HelmEvent[] };

// a full read at least this often, so a check from outside actions that the probes cannot see still lands
const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
// jobs read per poll, newest runs first
const JOB_READS = 12;
const RUNS_PAGE = 30;

// one repository's forge state. each poll asks two conditional probes, which cost nothing when unchanged, and reads
// the graphql snapshot only when one moved, a status check is pending, or the snapshot has aged out
export class RepoPoller {
  readonly repo: string;
  cache: RepoCache;
  private readonly gh: GitHub;
  private readonly stallMs: () => number;

  constructor(repo: string, gh: GitHub, cache: RepoCache, stallMs: () => number) {
    this.repo = repo;
    this.gh = gh;
    this.cache = cache.version === CACHE_VERSION ? cache : emptyCache();
    this.stallMs = stallMs;
  }

  get forge(): ForgeState | undefined {
    return this.cache.forge;
  }

  async poll(now: number, force = false): Promise<PollResult> {
    const prev = this.cache.forge;
    const [owner, name] = this.repo.split('/') as [string, string];
    const items = await this.gh.conditional<unknown[]>(`repos/${this.repo}/issues?state=all&sort=updated&direction=desc&per_page=1`);
    const runsRead = await this.gh.conditional<RestRuns>(`repos/${this.repo}/actions/runs?per_page=${RUNS_PAGE}`);
    const statusPending = prev?.pulls.some((p) => p.state === 'open' && p.checks.some((c) => c.run === undefined && !isDone(c.state))) ?? false;
    const stale = now - (this.cache.snapshotAt ?? 0) > SNAPSHOT_MAX_AGE_MS;
    let base = prev ? { defaultBranch: prev.defaultBranch, issues: prev.issues, pulls: prev.pulls } : undefined;
    if (!base || force || items.changed || runsRead.changed || statusPending || stale) {
      base = fromSnapshot(await this.gh.graphql<Snapshot>(SNAPSHOT_QUERY, { owner, name }));
      this.cache.snapshotAt = now;
    }
    const runs = await this.withJobs(fromRuns(runsRead.body), prev?.runs ?? [], now);
    for (const r of runs) {
      const tag = await this.isTag(r);
      if (tag) r.tag = true;
    }
    const next: ForgeState = { repo: this.repo, ...base, runs, polledAt: now };
    const { events, memory } = diffForge(prev, next, this.cache.memory, { now, stallMs: this.stallMs() });
    const changed = !prev || stripTime(prev) !== stripTime(next);
    this.cache = { ...this.cache, forge: next, memory };
    return { changed, events };
  }

  // whether anything here is moving: a run in flight or a pr head waiting on checks
  busy(): boolean {
    const f = this.cache.forge;
    if (!f) return false;
    return f.runs.some((r) => !isDone(r.state)) || f.pulls.some((p) => p.state === 'open' && verdictOf(p.checks) === 'pending');
  }

  // jobs with their steps for each run in flight, and once more for a run that just finished; the rest keep theirs
  private async withJobs(runs: Run[], before: readonly Run[], now: number): Promise<Run[]> {
    const was = new Map(before.map((r) => [r.id, r]));
    let reads = 0;
    const out: Run[] = [];
    for (const r of runs) {
      const old = was.get(r.id);
      const settled = old?.jobs !== undefined && isDone(r.state) && old.state === r.state;
      const wanted = !settled && (!isDone(r.state) || (old !== undefined && !isDone(old.state)) || (old === undefined && now - Date.parse(r.updatedAt) < 3600_000));
      if (wanted && reads < JOB_READS) {
        reads++;
        const read = await this.gh.conditional<RestJobs>(`repos/${this.repo}/actions/runs/${r.id}/jobs?per_page=100`).catch(() => undefined);
        out.push(read ? { ...r, jobs: fromJobs(read.body) } : withOld(r, old));
      } else out.push(withOld(r, old));
    }
    return out;
  }

  private async isTag(r: Run): Promise<boolean> {
    if (r.event !== 'push' && r.event !== 'release') return false;
    if (!r.branch) return false;
    const known = this.cache.tags[r.branch];
    if (known !== undefined) return known;
    const refs = await this.gh.get<{ ref: string }[]>(`repos/${this.repo}/git/matching-refs/tags/${encodeURIComponent(r.branch)}`).catch(() => undefined);
    if (refs === undefined) return false;
    const tag = refs.some((x) => x.ref === `refs/tags/${r.branch}`);
    this.cache.tags[r.branch] = tag;
    return tag;
  }
}

function withOld(r: Run, old: Run | undefined): Run {
  return old?.jobs ? { ...r, jobs: old.jobs } : r;
}

function stripTime(f: ForgeState): string {
  return JSON.stringify({ ...f, polledAt: 0 });
}
