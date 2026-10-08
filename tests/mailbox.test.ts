import { describe, expect, it } from 'vitest';
import type { AgentStatus, Letter } from '../src/core/types.ts';
import { GRACE_MS, Mailbox } from '../src/mod/mailbox.ts';

function harness(status: Record<string, AgentStatus | undefined>, refuse?: string) {
  const held = new Map<string, Letter>();
  const out = { submitted: [] as string[], sent: [] as [string, string][], retired: [] as string[], timers: [] as { ms: number; fn: () => Promise<void> }[] };
  let now = 1_000_000;
  const box = new Mailbox({
    now: () => now,
    take: async (id) => {
      const l = held.get(id);
      held.delete(id);
      return l;
    },
    submit: async (t) => void out.submitted.push(t),
    send: async (a, t) => {
      out.sent.push([a, t]);
      return refuse;
    },
    retire: async (a) => void out.retired.push(a),
    status: async (a) => status[a],
    after: (ms, fn) => {
      out.timers.push({ ms, fn });
      return { cancel: () => (out.timers = out.timers.filter((t) => t.fn !== fn)) };
    },
    log: () => {},
  });
  const letter = (id: string, agent?: string): Letter => {
    const l = { id, session: 'S', text: `text ${id}`, events: [], subs: [], at: now, ...(agent ? { agent } : {}) };
    held.set(id, l);
    return l;
  };
  return { box, out, letter, tick: (ms: number) => (now += ms) };
}

describe('mailbox', () => {
  it('starts a main-loop turn when idle, and rides the next tool call when busy', async () => {
    const h = harness({});
    await h.box.receive(h.letter('l1'));
    expect(h.out.submitted).toEqual(['text l1']);
    h.box.turnStarted();
    await h.box.receive(h.letter('l2'));
    expect(await h.box.attach(undefined)).toEqual(['text l2']);
    await h.box.turnEnded();
    expect(h.out.submitted).toEqual(['text l1']);
  });

  it('holds an agent letter for its next tool call, then messages it after the grace', async () => {
    const h = harness({ A: 'running' });
    await h.box.receive(h.letter('l1', 'A'));
    expect(h.out.timers[0]?.ms).toBe(GRACE_MS);
    await h.out.timers[0]!.fn();
    expect(h.out.sent).toEqual([['A', 'text l1']]);
  });

  it('messages an agent that has ended at once, and relays and retires when refused', async () => {
    const h = harness({ A: 'completed' }, 'no such agent');
    await h.box.receive(h.letter('l1', 'A'));
    expect(h.out.sent.length).toBe(1);
    expect(h.out.submitted[0]).toMatch(/^\[helm relay\] for agent A/);
    expect(h.out.retired).toEqual(['A']);
  });

  it('delivers nothing a peer environment took first', async () => {
    const h = harness({ A: 'running' });
    const l = h.letter('l1', 'A');
    await h.box.receive(l);
    await h.box.receive(l);
    expect(await h.box.attach('A')).toEqual(['text l1']);
    expect(await h.box.attach('A')).toEqual([]);
  });
});
