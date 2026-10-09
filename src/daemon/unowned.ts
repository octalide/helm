import type { HelmEvent, Issue } from '../core/types.ts';
import type { UnownedIssue } from './ledger.ts';

// how long a newly opened issue waits for a session to queue or claim it before the fleet hears nobody owns it
export const UNOWNED_MS = 30 * 60_000;

// when an opened issue counts as unowned: at once with no live repo session in its repository, else once its window ends
export const unownedDue = (u: UnownedIssue): number => u.openedAt + (u.alone ? 0 : UNOWNED_MS);

export function unownedEvent(u: UnownedIssue, i: Issue, now: number): HelmEvent {
  const why = u.alone ? `opened with no live session in ${u.repo}` : `still unowned ${UNOWNED_MS / 60_000}m after it opened`;
  return {
    id: `${u.repo}:issue#${u.issue}:unowned`,
    kind: 'issue',
    repo: u.repo,
    issue: u.issue,
    url: i.url,
    at: now,
    tags: ['unowned'],
    author: i.author,
    text: `issue #${u.issue} ${why}: ${i.title}`,
    detail: i.labels.length ? [`labels: ${i.labels.join(', ')}`] : [],
  };
}
