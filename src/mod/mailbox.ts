import { deliveryText } from '../core/letter.ts';
import type { AgentStatus, Letter } from '../core/types.ts';

export type Timer = { cancel: () => void };

export type MailHost = {
  now: () => number;
  // claims a letter from helmd; undefined when another environment or session took it first
  take: (id: string) => Promise<Letter | undefined>;
  // a turn of the main loop's own; false when a hook dropped it, so no turn comes of it
  submit: (text: string) => Promise<boolean>;
  // undefined once the engine queued it, else why it refused
  send: (agent: string, text: string) => Promise<string | undefined>;
  // retires every subscription the agent owns, once nothing can reach it
  retire: (agent: string) => Promise<void>;
  // the agent as the engine lists it now; undefined when it is not listed
  status: (agent: string) => Promise<AgentStatus | undefined>;
  after: (ms: number, fn: () => Promise<void>) => Timer;
  log: (line: string) => void;
};

// how long a letter waits for its agent's next tool call before it goes by message
export const GRACE_MS = 60_000;

const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);

// where a letter lands. one for the main loop rides its next tool call while a turn runs; between turns, every letter
// waiting goes as one prompt, which starts a turn. one for an agent rides that agent's next tool call; after the grace,
// or at once when the agent has ended, it goes as a message, which resumes an ended agent. a message the engine refuses
// goes to the main loop as a relay and the agent's subscriptions are retired. letters that go together are one text,
// a work item's older phases folded into its newest. helmd hands each letter out once, so two environments never both
// deliver it
export class Mailbox {
  private readonly waiting = new Map<string, Letter>();
  private readonly timers = new Map<string, Timer>();
  // a main-loop turn runs, or a prompt this mailbox submitted is on its way to one: either ends at turn.complete
  private busy = false;
  // main-loop turns ended, so a submission can tell whether the turn events took over the busy flag while it waited
  private ended = 0;
  private readonly host: MailHost;

  constructor(host: MailHost) {
    this.host = host;
  }

  async receive(l: Letter): Promise<void> {
    if (this.waiting.has(l.id)) return;
    this.waiting.set(l.id, l);
    if (l.agent === undefined) return this.prompt();
    const status = await this.host.status(l.agent);
    if (status === undefined || FINISHED.has(status)) return this.flush(l.agent);
    this.arm(l.agent, Math.max(0, l.at + GRACE_MS - this.host.now()));
  }

  // the text that rides a tool call's result, the calling loop's letters taken from helmd as they go
  async attach(agent: string | undefined): Promise<string | undefined> {
    const key = agent ?? '';
    const mine = this.mine(key);
    if (!mine.length) return undefined;
    this.disarm(key);
    const taken: Letter[] = [];
    for (const l of mine) {
      this.waiting.delete(l.id);
      const t = await this.host.take(l.id);
      if (t) taken.push(t);
    }
    return taken.length ? deliveryText(taken) : undefined;
  }

  turnStarted(): void {
    this.busy = true;
  }

  // a main-loop turn ended: what is still waiting starts the next one
  async turnEnded(): Promise<void> {
    this.busy = false;
    this.ended++;
    await this.prompt();
  }

  // an agent's loop ended: what waits for it goes now, as a message that resumes it
  async agentEnded(agent: string): Promise<void> {
    if (this.mine(agent).length) await this.flush(agent);
  }

  pending(): { to: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const l of this.waiting.values()) counts.set(l.agent ?? 'main', (counts.get(l.agent ?? 'main') ?? 0) + 1);
    return [...counts].map(([to, count]) => ({ to, count }));
  }

  stop(): void {
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
  }

  private mine(key: string): Letter[] {
    return [...this.waiting.values()].filter((l) => (l.agent ?? '') === key).sort((a, b) => a.at - b.at);
  }

  private arm(key: string, ms: number): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      this.host.after(ms, async () => {
        this.timers.delete(key);
        await this.flush(key);
      }),
    );
  }

  private disarm(key: string): void {
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }

  // the main loop's waiting letters as one prompt, unless a turn runs or one is on its way. the loop is busy from the
  // first take, so a letter that lands meanwhile waits for that turn instead of making a prompt of its own
  private async prompt(): Promise<void> {
    while (!this.busy && this.mine('').length) {
      this.busy = true;
      const ended = this.ended;
      const text = await this.attach(undefined);
      if (text !== undefined) await this.submit(text);
      else if (ended === this.ended) this.busy = false;
    }
  }

  // a prompt holds the loop busy until its turn ends; one a hook dropped starts no turn, so it frees the loop, unless
  // a turn ended meanwhile and the turn events hold the flag
  private async submit(text: string): Promise<void> {
    this.busy = true;
    const ended = this.ended;
    const entered = await this.host.submit(text);
    if (entered) return;
    this.host.log('helm: a prompt of letters was dropped by a hook');
    if (ended === this.ended) this.busy = false;
  }

  private async flush(agent: string): Promise<void> {
    const text = await this.attach(agent);
    if (text === undefined) return;
    let refused: string | undefined;
    try {
      refused = await this.host.send(agent, text);
    } catch (e) {
      refused = (e as Error).message;
    }
    if (refused === undefined) return;
    this.host.log(`helm: a message to agent ${agent} was refused (${refused}); relayed to the main loop`);
    await this.submit([`[helm relay] for agent ${agent}, which a message could not reach: ${refused}`, text].join('\n'));
    await this.host.retire(agent);
  }
}
