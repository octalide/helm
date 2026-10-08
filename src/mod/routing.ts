import type { IssueDetail, RoutingConfig } from '../core/protocol.ts';
import type { Routing, Tier } from '../core/types.ts';

const BODY_CHARS = 8000;
const COMMENT_CHARS = 1500;
const COMMENTS = 6;

export function routingPrompt(issue: IssueDetail, tiers: readonly Tier[]): string {
  const comments = issue.comments.slice(-COMMENTS).map((c) => `--- ${c.author}, ${c.at}\n${clip(c.body, COMMENT_CHARS)}`);
  return [
    'You route a GitHub issue to the cheapest tier of model and reasoning effort that will implement it correctly in one pass.',
    'An agent at that tier reads the issue, plans, edits code across the repository, runs the tests and opens a pull request on its own.',
    'Underpowering costs a failed attempt and a rerun on a higher tier; overpowering costs money. Judge the work the issue asks for, not how it is written.',
    '',
    'Tiers, cheapest first:',
    ...tiers.map((t, i) => `${i + 1}. ${t.name} (${t.model}, ${t.effort} effort): ${t.when}`),
    '',
    `Issue ${issue.repo}#${issue.number}: ${issue.title}`,
    `labels: ${issue.labels.join(', ') || 'none'}`,
    '',
    clip(issue.body, BODY_CHARS) || '(no body)',
    ...(comments.length ? ['', `Latest comments (${issue.comments.length} in all):`, ...comments] : []),
    '',
    'Answer with one JSON object and nothing else:',
    '{"tier": "<tier name>", "confidence": <0 to 1, how sure you are this is the right tier>, "reason": "<one sentence naming what decided it>"}',
  ].join('\n');
}

// the judge's answer as a routing; anything it got wrong falls back to the configured tier, at no confidence
export function parseRouting(text: string, cfg: RoutingConfig, now: number): Routing {
  const fallback = cfg.tiers.find((t) => t.name === cfg.fallback) ?? cfg.tiers[0]!;
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let raw: { tier?: unknown; confidence?: unknown; reason?: unknown } = {};
  try {
    raw = json ? (JSON.parse(json) as typeof raw) : {};
  } catch {}
  const tier = cfg.tiers.find((t) => t.name === raw.tier);
  if (!tier) return { ...asRouting(fallback, 'judge', now), confidence: 0, reason: `the judge named no known tier (${clip(text.trim(), 120)}); fell back to ${fallback.name}` };
  const confidence = typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0;
  return { ...asRouting(tier, 'judge', now), confidence, reason: typeof raw.reason === 'string' ? clip(raw.reason, 300) : '' };
}

export function asRouting(t: Tier, by: Routing['by'], now: number): Routing {
  return { tier: t.name, model: t.model, effort: t.effort, by, at: now };
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
