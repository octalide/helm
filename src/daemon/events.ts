import { isDone, isPassing, verdictOf } from '../core/checks.ts';
import type { Check, ForgeState, HelmEvent, Issue, Pull, Run, Verdict } from '../core/types.ts';

// what the ci diff remembers between polls, kept with the repository's cache
export type CiMemory = {
  // pr@sha -> the verdict last delivered for that head
  settled: Record<string, Verdict>;
  // pr@sha -> when the head was first seen with checks unfinished
  pending: Record<string, number>;
  // pr@sha -> stalled delivered once
  stalled: Record<string, true>;
};

export const emptyMemory = (): CiMemory => ({ settled: {}, pending: {}, stalled: {} });

export type DiffOptions = { now: number; stallMs: number };

// an item first seen within this long of the previous poll counts as new, not paged in from beyond the window
const FRESH_MS = 120_000;

const short = (sha: string) => sha.slice(0, 7);

const headKey = (p: Pull) => `${p.number}@${p.sha}`;

// the events between two polls of one repository. the first poll (no prev) only seeds what ci has already settled,
// so nothing that happened before helm looked is delivered as news
export function diffForge(prev: ForgeState | undefined, next: ForgeState, memory: CiMemory, opts: DiffOptions): { events: HelmEvent[]; memory: CiMemory } {
  const events: HelmEvent[] = [];
  const mem: CiMemory = { settled: {}, pending: {}, stalled: {} };
  const seeding = prev === undefined;
  const since = (prev?.polledAt ?? opts.now) - FRESH_MS;
  const fresh = (at: string | undefined) => at !== undefined && Date.parse(at) > since;

  if (!seeding) {
    const before = new Map(prev.issues.map((i) => [i.number, i]));
    for (const i of next.issues) events.push(...issueEvents(next.repo, before.get(i.number), i, fresh, opts.now));
    const beforePulls = new Map(prev.pulls.map((p) => [p.number, p]));
    for (const p of next.pulls) events.push(...pullEvents(next.repo, beforePulls.get(p.number), p, fresh, opts.now));
    const beforeRuns = new Map(prev.runs.map((r) => [r.id, r]));
    for (const r of next.runs) {
      const was = beforeRuns.get(r.id);
      if (isDone(r.state) && (was ? !isDone(was.state) : fresh(r.updatedAt))) events.push(runEvent(next.repo, r, opts.now));
    }
  }

  for (const p of next.pulls) {
    if (p.state !== 'open') continue;
    const key = headKey(p);
    const verdict = verdictOf(p.checks);
    if (verdict === 'success' || verdict === 'failure') {
      if (!seeding && memory.settled[key] !== verdict) events.push(verdictEvent(next.repo, p, verdict, opts.now));
      mem.settled[key] = verdict;
      continue;
    }
    if (memory.settled[key]) mem.settled[key] = memory.settled[key];
    if (verdict !== 'pending') continue;
    const at = memory.pending[key] ?? opts.now;
    mem.pending[key] = at;
    if (memory.stalled[key]) mem.stalled[key] = true;
    else if (opts.now - at > opts.stallMs) {
      mem.stalled[key] = true;
      if (!seeding) events.push(stallEvent(next.repo, p, opts.now));
    }
  }
  return { events, memory: mem };
}

function base(repo: string, now: number, kind: HelmEvent['kind'], id: string): Pick<HelmEvent, 'id' | 'kind' | 'repo' | 'at'> {
  return { id: `${repo}:${id}`, kind, repo, at: now };
}

function issueEvents(repo: string, was: Issue | undefined, i: Issue, fresh: (at?: string) => boolean, now: number): HelmEvent[] {
  const about = { issue: i.number, url: i.url };
  const head = `issue #${i.number}`;
  if (!was) {
    if (i.state === 'open' && fresh(i.createdAt)) {
      return [{ ...base(repo, now, 'issue', `issue#${i.number}:opened`), ...about, tags: ['opened'], author: i.author, text: `${head} opened by ${i.author.login}: ${i.title}`, detail: labelsLine(i.labels) }];
    }
    if (i.state === 'closed' && fresh(i.closedAt)) {
      return [{ ...base(repo, now, 'issue', `issue#${i.number}:closed@${i.closedAt}`), ...about, tags: ['closed'], text: `${head} closed${i.reason ? ` (${i.reason})` : ''}: ${i.title}` }];
    }
    return [];
  }
  const out: HelmEvent[] = [];
  if (was.state !== i.state) {
    const tag = i.state === 'closed' ? 'closed' : 'reopened';
    out.push({ ...base(repo, now, 'issue', `issue#${i.number}:${tag}@${i.updatedAt}`), ...about, tags: [tag], text: `${head} ${tag}${i.reason && tag === 'closed' ? ` (${i.reason})` : ''}: ${i.title}` });
  }
  if (i.comments > was.comments) out.push(commentEvent(repo, 'issue', i.number, i.title, i.url, i.comments - was.comments, i.lastComment, now));
  if (was.title !== i.title) out.push({ ...base(repo, now, 'issue', `issue#${i.number}:edited@${i.updatedAt}`), ...about, tags: ['edited'], text: `${head} retitled: ${was.title} → ${i.title}` });
  if (was.labels.join(',') !== i.labels.join(',')) {
    out.push({ ...base(repo, now, 'issue', `issue#${i.number}:labeled@${i.updatedAt}`), ...about, tags: ['labeled'], text: `${head} labels [${i.labels.join(', ')}]: ${i.title}` });
  }
  return out;
}

function pullEvents(repo: string, was: Pull | undefined, p: Pull, fresh: (at?: string) => boolean, now: number): HelmEvent[] {
  const about = { pr: p.number, branch: p.head, sha: p.sha, url: p.url };
  const head = `pr #${p.number}`;
  const where = `${p.head} → ${p.base}`;
  if (!was) {
    if (p.state === 'open' && fresh(p.createdAt)) {
      return [{ ...base(repo, now, 'pr', `pr#${p.number}:opened`), ...about, tags: ['opened', ...(p.draft ? ['draft'] : [])], author: p.author, text: `${head} opened${p.draft ? ' as draft' : ''} by ${p.author.login}, ${where}: ${p.title}`, detail: closesLine(p) }];
    }
    if (p.state !== 'open' && fresh(p.closedAt)) return [closedPull(repo, p, now)];
    return [];
  }
  const out: HelmEvent[] = [];
  if (was.state !== p.state) {
    if (p.state === 'open') out.push({ ...base(repo, now, 'pr', `pr#${p.number}:reopened@${p.updatedAt}`), ...about, tags: ['reopened'], text: `${head} reopened, ${where}: ${p.title}` });
    else out.push(closedPull(repo, p, now));
    return out;
  }
  if (p.state !== 'open') return out;
  if (was.draft !== p.draft) {
    const tag = p.draft ? 'draft' : 'ready';
    out.push({ ...base(repo, now, 'pr', `pr#${p.number}:${tag}@${p.updatedAt}`), ...about, tags: [tag], text: `${head} ${p.draft ? 'converted to draft' : 'marked ready'}, ${where}: ${p.title}` });
  }
  if (was.sha !== p.sha) out.push({ ...base(repo, now, 'pr', `pr#${p.number}:pushed@${p.sha}`), ...about, tags: ['pushed'], text: `${head} head @${short(was.sha)} → @${short(p.sha)}: ${p.title}` });
  if (p.comments > was.comments) out.push(commentEvent(repo, 'pr', p.number, p.title, p.url, p.comments - was.comments, p.lastComment, now, about));
  if (p.reviews > was.reviews && p.lastReview) {
    const r = p.lastReview;
    out.push({ ...base(repo, now, 'pr', `pr#${p.number}:review@${r.at}`), ...about, url: r.url, tags: ['review'], author: r.author, text: `${head} review ${r.state} by ${r.author.login}: ${p.title}`, detail: quote(r.text) });
  }
  if (was.title !== p.title) out.push({ ...base(repo, now, 'pr', `pr#${p.number}:edited@${p.updatedAt}`), ...about, tags: ['edited'], text: `${head} retitled: ${was.title} → ${p.title}` });
  return out;
}

function closedPull(repo: string, p: Pull, now: number): HelmEvent {
  const tag = p.state === 'merged' ? 'merged' : 'closed';
  return { ...base(repo, now, 'pr', `pr#${p.number}:${tag}`), pr: p.number, branch: p.head, sha: p.sha, url: p.url, tags: [tag], text: `pr #${p.number} ${tag}, ${p.head} → ${p.base}: ${p.title}`, detail: closesLine(p) };
}

function commentEvent(repo: string, kind: 'issue' | 'pr', n: number, title: string, url: string, count: number, last: Issue['lastComment'], now: number, about: Partial<HelmEvent> = { issue: n }): HelmEvent {
  const by = last ? ` by ${last.author.login}` : '';
  const more = count > 1 ? ` (+${count - 1} more)` : '';
  return {
    ...base(repo, now, kind, `${kind}#${n}:comment@${last?.at ?? now}`),
    ...about,
    url: last?.url ?? url,
    tags: ['comment'],
    ...(last ? { author: last.author } : {}),
    text: `${kind} #${n} comment${by}${more}: ${title}`,
    detail: last ? quote(last.text) : [],
  };
}

export function verdictEvent(repo: string, p: Pull, verdict: 'success' | 'failure', now: number): HelmEvent {
  const failed = p.checks.filter((c) => !isPassing(c.state));
  const counts = `${p.checks.length} check${p.checks.length === 1 ? '' : 's'}${failed.length ? `, failed: ${failed.map((c) => c.name).join(', ')}` : ''}`;
  return {
    ...base(repo, now, 'ci', `pr#${p.number}@${p.sha}:${verdict}`),
    pr: p.number,
    branch: p.head,
    sha: p.sha,
    url: p.url,
    tags: ['settled', verdict],
    text: `ci settled ${verdict}: pr #${p.number} ${p.head} @${short(p.sha)} (${counts}): ${p.title}`,
    detail: failureLines(failed),
  };
}

function stallEvent(repo: string, p: Pull, now: number): HelmEvent {
  const pending = p.checks.filter((c) => !isDone(c.state));
  return {
    ...base(repo, now, 'ci', `pr#${p.number}@${p.sha}:stalled`),
    pr: p.number,
    branch: p.head,
    sha: p.sha,
    url: p.url,
    tags: ['stalled'],
    text: `ci stalled: pr #${p.number} ${p.head} @${short(p.sha)} (${pending.length} of ${p.checks.length} checks pending: ${pending.map((c) => c.name).join(', ')}): ${p.title}`,
  };
}

function runEvent(repo: string, r: Run, now: number): HelmEvent {
  return {
    ...base(repo, now, 'ci', `run#${r.id}:${r.state}@${r.updatedAt}`),
    run: r.id,
    branch: r.branch,
    sha: r.sha,
    url: r.url,
    ...(r.tag ? { tag: r.branch } : {}),
    tags: ['completed', r.state],
    text: `ci ${r.state}: ${r.workflow} on ${r.tag ? 'tag ' : ''}${r.branch} @${short(r.sha)} (${r.event}), run ${r.id}`,
  };
}

// each failed run with its failed checks and how to read its log; a check with no actions run has no log here
export function failureLines(failed: readonly Check[]): string[] {
  const runs = new Map<number, string[]>();
  const bare: string[] = [];
  for (const c of failed) {
    if (c.run === undefined) bare.push(c.name);
    else runs.set(c.run, [...(runs.get(c.run) ?? []), c.name]);
  }
  return [
    ...[...runs].map(([run, names]) => `run ${run} failed: ${names.join(', ')} · log: helm log run=${run}`),
    ...(bare.length ? [`no log: ${bare.join(', ')}`] : []),
  ];
}

function quote(text: string): string[] {
  const line = text.replace(/\s+/g, ' ').trim();
  return line ? [`> ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`] : [];
}

function labelsLine(labels: string[]): string[] {
  return labels.length ? [`labels: ${labels.join(', ')}`] : [];
}

function closesLine(p: Pull): string[] {
  return p.closes.length ? [`closes ${p.closes.map((n) => `#${n}`).join(', ')}`] : [];
}
