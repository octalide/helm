import type { ForgeState, HelmEvent, Subscription } from '../core/types.ts';

// the item tags a subscription takes when it names none: what someone acts on, not housekeeping
export const DEFAULT_ITEM_TAGS: Record<string, readonly string[]> = {
  repo: ['opened', 'closed', 'reopened', 'merged', 'ready', 'comment', 'review'],
  issue: ['opened', 'closed', 'reopened', 'comment', 'edited', 'labeled'],
  pr: ['opened', 'closed', 'reopened', 'merged', 'ready', 'draft', 'comment', 'review', 'pushed', 'edited'],
  branch: [],
  run: [],
  tag: [],
  work: ['phase', 'answered'],
  fleet: ['phase', 'decision', 'answered', 'progress'],
};

const ATTENTION: ReadonlySet<string> = new Set(['blocked', 'failing', 'stalled']);

export type MatchContext = {
  // branches a repo-scope subscription hears failed runs on: the default branch and the long-lived ones
  protectedBranches: ReadonlySet<string>;
  // behindKey pairs whose sha is known to be strictly behind a subscription's expected head
  behind?: ReadonlySet<string>;
};

export const behindKey = (sha: string, head: string): string => `${sha}..${head}`;

export function globMatch(glob: string, text: string): boolean {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(text);
}

function inScope(e: HelmEvent, s: Subscription): boolean {
  const scope = s.scope;
  // the fleet hears an epic's work through its progress, except what needs someone
  if (scope.kind === 'fleet') return e.kind === 'decision' || e.kind === 'epic' || (e.kind === 'work' && (!e.epic || e.tags.some((t) => ATTENTION.has(t))));
  if (scope.kind === 'work') return (e.kind === 'work' || e.kind === 'decision') && e.owner === s.session;
  if (e.kind === 'work' || e.kind === 'decision' || e.kind === 'epic') return false;
  if (s.repo !== e.repo) return false;
  switch (scope.kind) {
    case 'repo':
      return true;
    case 'issue':
      return e.issue === scope.number;
    case 'pr':
      return e.pr === scope.number;
    case 'branch':
      return e.kind === 'ci' && e.branch === scope.name && e.tag === undefined;
    case 'run':
      return e.run === scope.id;
    case 'tag':
      return e.tag !== undefined && globMatch(scope.glob, e.tag);
  }
}

function ciTaken(e: HelmEvent, s: Subscription, ctx: MatchContext): boolean {
  if (s.ci === 'none') return false;
  const verdict = e.tags.includes('settled');
  const stalled = e.tags.includes('stalled');
  const failed = e.tags.includes('failure') || e.tags.includes('cancelled');
  const run = e.tags.includes('completed');
  // a subscription that ends once settled takes what settles it, whatever its filter would hold back
  if (s.until === 'settled' && (verdict || run)) return true;
  if (s.ci === 'all') return true;
  if (verdict) return s.ci === 'settled' || failed;
  if (stalled) return true;
  if (!run) return false;
  const kind = s.scope.kind;
  if (kind === 'run' || kind === 'branch' || kind === 'tag') return s.ci === 'settled' || failed;
  // on a whole repository, runs on pr heads speak through the pr's verdict; only long-lived branches and tags report
  const lasting = e.tag !== undefined || (e.branch !== undefined && ctx.protectedBranches.has(e.branch));
  return lasting && failed;
}

export function matches(e: HelmEvent, s: Subscription, ctx: MatchContext): boolean {
  if (!inScope(e, s)) return false;
  if (e.author?.bot && !s.bots) return false;
  if (e.kind === 'ci') {
    // ci on a head the subscriber has pushed past speaks of code it no longer waits on
    if (s.scope.kind === 'pr' && s.head && e.sha && ctx.behind?.has(behindKey(e.sha, s.head))) return false;
    return ciTaken(e, s, ctx);
  }
  const tags = s.tags ?? DEFAULT_ITEM_TAGS[s.scope.kind] ?? [];
  return e.tags.some((t) => tags.includes(t));
}

// whether a subscription has run its course once this event reached it
export function retiredBy(e: HelmEvent, s: Subscription): boolean {
  if (s.scope.kind === 'run' && e.tags.includes('completed')) return true;
  const ends = e.tags.includes('merged') || e.tags.includes('closed');
  if (s.scope.kind === 'pr' && ends && s.until !== undefined) return true;
  if (s.until === 'settled') return e.tags.includes('settled') || (e.tags.includes('completed') && s.scope.kind !== 'pr');
  if (s.until === 'merged') return e.tags.includes('merged');
  if (s.until === 'closed') return ends;
  return false;
}

export function expired(s: Subscription, now: number): boolean {
  return typeof s.until === 'object' && Date.parse(s.until.at) <= now;
}

// whether what a subscription with an end waits on has ended by the forge's own state: its pr merged or closed, or its
// issue closed under until closed. the event that would have retired it may have come while helm was not watching
export function ended(s: Subscription, forge: ForgeState | undefined): boolean {
  if (s.until === undefined || !forge) return false;
  const scope = s.scope;
  if (scope.kind === 'pr') {
    const p = forge.pulls.find((x) => x.number === scope.number);
    return p !== undefined && p.state !== 'open';
  }
  if (scope.kind === 'issue' && s.until === 'closed') return forge.issues.some((i) => i.number === scope.number && i.state === 'closed');
  return false;
}
