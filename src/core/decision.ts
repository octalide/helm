import type { Decision, DecisionKind } from './types.ts';

// what was decided without the person, kept for review: it needs no answer and never waits on anyone
export const RECORD_KINDS: ReadonlySet<DecisionKind> = new Set(['choice', 'routing']);

export const isRecord = (d: Pick<Decision, 'kind'>): boolean => RECORD_KINDS.has(d.kind);

// open and waiting on someone to decide it
export const isOpen = (d: Pick<Decision, 'kind' | 'state'>): boolean => d.state === 'open' && !isRecord(d);

export const forPerson = (d: Pick<Decision, 'kind' | 'state' | 'to'>): boolean => isOpen(d) && d.to === 'person';

export const forSession = (d: Pick<Decision, 'kind' | 'state' | 'to' | 'session'>, session: string): boolean => isOpen(d) && d.to === 'session' && d.session === session;

// a record not yet marked reviewed
export const unreviewed = (d: Pick<Decision, 'kind' | 'state'>): boolean => d.state === 'open' && isRecord(d);
