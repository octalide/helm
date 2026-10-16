import type { AgentRecord } from '../core/types.ts';

type Listed = Pick<AgentRecord, 'id' | 'type' | 'parentId'> & { name?: string | undefined };

// where an agent's SendMessage goes: through the engine as addressed, or to this session's main loop. the engine
// resolves a name across every session on the machine, so an issue agent answering "the coordinator" its parent's
// message speaks of reaches the session that carries that name, not its own. an issue agent, and any agent it
// started, answers only to the session that dispatched it: a send of theirs that names no other agent of this
// session goes to the main loop
export function sendRoute(to: string, sender: string, agents: readonly Listed[], isIssue: (type: string) => boolean): 'engine' | 'session' {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const seen = new Set<string>();
  let a = byId.get(sender);
  while (a && !isIssue(a.type) && a.parentId !== undefined && !seen.has(a.id)) {
    seen.add(a.id);
    a = byId.get(a.parentId);
  }
  if (!a || !isIssue(a.type)) return 'engine';
  return agents.some((x) => x.id !== sender && (x.id === to || x.name === to)) ? 'engine' : 'session';
}
