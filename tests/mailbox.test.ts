import { describe, expect, it } from 'vitest';
import type { AgentStatus, Letter } from '../src/core/types.ts';
import { GRACE_MS, Mailbox } from '../src/mod/mailbox.ts';

function harness(status: Record<string, AgentStatus | undefined>, refuse?: string, drop = false) {
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
    submit: async (t) => {
      out.submitted.push(t);
      return !drop;
    },
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
  const letter = (id: string, agent?: string, parts?: Letter['parts']): Letter => {
    const l = { id, session: 'S', text: `text ${id}`, events: [], subs: [], at: now, ...(agent ? { agent } : {}), ...(parts ? { parts } : {}) };
    held.set(id, l);
    return l;
  };
  return { box, out, letter, tick: (ms: number) => (now += ms) };
}

describe('mailbox', () => {
  it('rides the next tool call while a turn runs, and sends what the turn left as one prompt when it ends', async () => {
    const h = harness({});
    h.box.turnStarted();
    await h.box.receive(h.letter('l1'));
    expect(h.out.submitted).toEqual([]);
    expect(await h.box.attach(undefined)).toBe('text l1');
    await h.box.receive(h.letter('l2'));
    await h.box.receive(h.letter('l3'));
    await h.box.turnEnded();
    expect(h.out.submitted).toEqual(['text l2\n\ntext l3']);
  });

  it('starts a turn when idle, and holds what lands before that turn ends for one more prompt', async () => {
    const h = harness({});
    await h.box.receive(h.letter('l1'));
    await h.box.receive(h.letter('l2'));
    await h.box.receive(h.letter('l3'));
    expect(h.out.submitted).toEqual(['text l1']);
    await h.box.turnEnded();
    expect(h.out.submitted).toEqual(['text l1', 'text l2\n\ntext l3']);
  });

  it('frees the loop when a hook drops the prompt', async () => {
    const h = harness({}, undefined, true);
    await h.box.receive(h.letter('l1'));
    await h.box.receive(h.letter('l2'));
    expect(h.out.submitted).toEqual(['text l1', 'text l2']);
  });

  it('folds a work item\'s older phases into its newest', async () => {
    const h = harness({});
    const phase = (from: string, to: string) => ({ head: 'work', lines: [`o/r#1 ${from} → ${to}: t`, `  ${to} detail`], phase: { key: 'o/r#1', path: [from, to], title: 't' } });
    h.box.turnStarted();
    await h.box.receive(h.letter('l1', undefined, [phase('working', 'draft')]));
    await h.box.receive(h.letter('l2', undefined, [{ head: 'o/r', lines: ['pr #2 opened'] }]));
    await h.box.receive(h.letter('l3', undefined, [phase('draft', 'ci'), phase('ci', 'ready')]));
    expect(await h.box.attach(undefined)).toBe('[helm o/r]\npr #2 opened\n\n[helm work]\no/r#1 working → draft → ci → ready: t\n  ready detail');
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
    expect(await h.box.attach('A')).toBe('text l1');
    expect(await h.box.attach('A')).toBeUndefined();
  });
});
