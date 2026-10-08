import type { AgentRecord, CiFilter, Decision, DecisionKind, Effort, Letter, ReportState, RepoName, Routing, Scope, SessionRole, Tier, Until } from './types.ts';

// bumped when a route or a body changes shape; a mod that finds an older daemon replaces it
export const PROTOCOL = 1;

export type Health = { version: string; protocol: number; pid: number; startedAt: number; web?: string };

export type RegisterBody = { id: string; cwd: string; role?: SessionRole; repo?: RepoName; title?: string };

export type HeartbeatBody = { agents: AgentRecord[] };

export type RoleBody = { role: SessionRole; repo?: RepoName };

export type SubscribeBody = {
  repo?: RepoName;
  scope: Scope;
  ci?: CiFilter;
  tags?: string[];
  bots?: boolean;
  until?: Until;
  session: string;
  agent?: string;
};

export type QueueBody = { session: string; repo: RepoName; issues: number[] };

export type ClaimBody = { session: string; repo: RepoName; issue: number; agent?: string; routing?: Routing; force?: boolean };

export type ReportBody = {
  session: string;
  agent?: string;
  repo: RepoName;
  issue: number;
  state: ReportState;
  note?: string;
  // a question that stops the agent until answered
  question?: { title: string; body: string; options?: string[] };
  // choices made without the person, logged for review
  choices?: { title: string; body: string }[];
};

export type ReleaseBody = { session: string; repo: RepoName; issue: number; how?: 'abandoned' };

export type OrderBody = { session: string; keys: string[] };

export type DecisionBody = {
  kind: DecisionKind;
  repo?: RepoName;
  issue?: number;
  title: string;
  body: string;
  options?: string[];
  blocking: boolean;
  from?: { session: string; agent?: string };
};

export type AnswerBody = { text: string; option?: string; by: string };

export type RoutingConfig = { judge: string; review: number; tiers: Tier[]; fallback: string };

export type ConfigView = { routing: RoutingConfig; web?: string };

// what a session's stream carries, one json object a line
export type StreamFrame =
  | { type: 'hello'; version: string; protocol: number }
  | { type: 'letter'; letter: Letter }
  | { type: 'changed'; at: number }
  | { type: 'ping'; at: number };

export type IssueDetail = {
  repo: RepoName;
  number: number;
  title: string;
  state: string;
  url: string;
  pr: boolean;
  author: string;
  labels: string[];
  body: string;
  comments: { author: string; at: string; url: string; body: string }[];
};

export type Problem = { error: string; detail?: unknown };

export type ClaimRefused = Problem & { owner: string };

export type Answered = { decision: Decision; delivered: boolean };

export function workKey(repo: RepoName, issue: number): string {
  return `${repo}#${issue}`;
}

export function parseWorkKey(key: string): { repo: RepoName; issue: number } | undefined {
  const m = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(key);
  return m ? { repo: m[1]!, issue: Number(m[2]) } : undefined;
}

export function isEffort(v: unknown): v is Effort {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max';
}
