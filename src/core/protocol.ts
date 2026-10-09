import { compareVersions } from './repo.ts';
import type { AgentRecord, CiFilter, Decision, DecisionKind, Effort, Letter, PlanStep, ReportState, RepoName, Routing, Scope, SessionRole, Tier, Until } from './types.ts';

// bumped when a route or a body changes shape; a mod that finds an older daemon replaces it
export const PROTOCOL = 3;

export type Health = { version: string; protocol: number; pid: number; startedAt: number; web?: string };

// what a mod does about the helmd it finds: start one, replace an older one, use one as new or newer, or, when that one
// speaks a newer protocol, wait for this session to reload onto a mod that speaks it. a newer helmd is never replaced
export function daemonAction(up: Pick<Health, 'version' | 'protocol'> | undefined, version: string, protocol = PROTOCOL): 'start' | 'restart' | 'use' | 'reload' {
  if (!up) return 'start';
  if (up.protocol > protocol) return 'reload';
  if (up.protocol < protocol || compareVersions(up.version, version) < 0) return 'restart';
  return 'use';
}

// from: the session this one goes on from in the same process, as a /clear or a resume ended it. role is the role the
// session was asked to take; repo is its checkout's, a default for a session helmd does not know. protocol is the mod's:
// before 3 a mod sent the role it guessed, which only defaults a new session
export type RegisterBody = { id: string; cwd: string; role?: SessionRole; repo?: RepoName; title?: string; from?: string; protocol?: number };

export type HeartbeatBody = { agents: AgentRecord[] };

export type RoleBody = { role: SessionRole; repo?: RepoName };

export type SubscribeBody = {
  repo?: RepoName;
  scope: Scope;
  ci?: CiFilter;
  tags?: string[];
  bots?: boolean;
  until?: Until;
  // a pr subscription's head as the caller pushed it: ci on a head strictly behind it is not delivered
  sha?: string;
  session: string;
  agent?: string;
};

export type QueueBody = { session: string; repo: RepoName; issues: number[] };

// title: what the caller read of the issue, for when the forge cache has not seen it yet
export type ClaimBody = { session: string; repo: RepoName; issue: number; title?: string; agent?: string; routing?: Routing; force?: boolean };

export type ReportBody = {
  session: string;
  agent?: string;
  repo: RepoName;
  issue: number;
  state: ReportState;
  note?: string;
  // a question that stops the agent until answered
  question?: { title: string; body: string; options?: string[] };
  // choices made without the person, recorded for review
  choices?: { title: string; body: string }[];
  // the plan as it stands, every step with whether it is done
  plan?: PlanStep[];
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

export type EscalateBody = { by: string; note?: string };

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
