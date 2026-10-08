import type { AgentStatus, Letter } from '../core/types.ts';

export type Timer = { cancel: () => void };

export type MailHost = {
  now: () => number;
  // claims a letter from helmd; undefined when another environment or session took it first
  take: (id: string) => Promise<Letter | undefined>;
  // a turn of the main loop's own
  submit: (text: string) => Promise<void>;
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

// where a letter lands. one for the main loop rides its next tool call while a turn runs, else starts a turn. one
// for an agent rides that agent's next tool call; after the grace, or at once when the agent has ended, it goes as a
// message, which resumes an ended agent. a message the engine refuses goes to the main loop as a relay and the
// agent's subscriptions are retired. helmd hands each letter out once, so two environments never both deliver it
export class Mailbox {
  private readonly waiting = new Map<string, Letter>();
  private readonly timers = new Map<string, Timer>();
  private busy = false;
  private readonly host: MailHost;

  constructor(host: MailHost) {
    this.host = host;
  }

  async receive(l: Letter): Promise<void> {
    if (this.waiting.has(l.id)) return;
    this.waiting.set(l.id, l);
    const key = l.agent ?? '';
    if (l.agent === undefined) {
      if (!this.busy) await this.flush(key);
      return;
    }
    const status = await this.host.status(l.agent);
    if (status === undefined || FINISHED.has(status)) return this.flush(key);
    this.arm(key, Math.max(0, l.at + GRACE_MS - this.host.now()));
  }

  // the letters that ride a tool call's result, taken from helmd as they go
  async attach(agent: string | undefined): Promise<string[]> {
    const key = agent ?? '';
    const mine = this.mine(key);
    if (!mine.length) return [];
    this.disarm(key);
    const texts: string[] = [];
    for (const l of mine) {
      this.waiting.delete(l.id);
      const taken = await this.host.take(l.id);
      if (taken) texts.push(taken.text);
    }
    return texts;
  }

  turnStarted(): void {
    this.busy = true;
  }

  // a main-loop turn ended with letters still waiting: they start the next one
  async turnEnded(): Promise<void> {
    this.busy = false;
    await this.flush('');
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

  private async flush(key: string): Promise<void> {
    const texts = await this.attach(key || undefined);
    if (!texts.length) return;
    const text = texts.join('\n\n');
    if (!key) return this.host.submit(text);
    let refused: string | undefined;
    try {
      refused = await this.host.send(key, text);
    } catch (e) {
      refused = (e as Error).message;
    }
    if (refused === undefined) return;
    this.host.log(`helm: a message to agent ${key} was refused (${refused}); relayed to the main loop`);
    await this.host.submit([`[helm relay] for agent ${key}, which a message could not reach: ${refused}`, text].join('\n'));
    await this.host.retire(key);
  }
}
