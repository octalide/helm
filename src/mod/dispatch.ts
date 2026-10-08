import { isRepoName } from '../core/repo.ts';
import { workKey } from '../core/protocol.ts';
import type { Effort, RepoName, Routing } from '../core/types.ts';
import { HelmError } from './client.ts';
import { asRouting, parseRouting, routingPrompt } from './routing.ts';
import type { Tool, ToolEnv } from './tools.ts';

// what dispatch needs of the engine, built by the hooks module
export type DispatchPort = {
  spawn: (a: { subagentType: string; model: string; description: string; prompt: string }) => Promise<{ agentId?: string; deny?: string }>;
  complete: (a: { model: string; prompt: string }) => Promise<{ text: string } | { failed: string }>;
  now: () => number;
};

export type DispatchInput = { repo?: RepoName; issues: number[]; tier?: string; context?: string };

// the agent type an issue runs as at one effort level: effort is a property of the type, not of a spawn
export const issueAgent = (plugin: string, effort: Effort) => `${plugin}:issue-${effort}`;

export async function dispatchIssues(env: ToolEnv, port: DispatchPort, plugin: string, input: DispatchInput): Promise<string> {
  const repo = env.repo(input.repo);
  const cfg = (await env.client.config(repo)).routing;
  const named = input.tier ? cfg.tiers.find((t) => t.name === input.tier) : undefined;
  if (input.tier && !named) throw new HelmError(400, `no tier ${input.tier}: ${cfg.tiers.map((t) => t.name).join(', ')}`);
  const lines: string[] = [];
  for (const issue of input.issues) {
    const key = workKey(repo, issue);
    try {
      const detail = await env.client.issue(repo, issue);
      if (detail.pr || detail.state !== 'open') {
        lines.push(`${key}: ${detail.pr ? 'a pull request' : detail.state}, not dispatched`);
        continue;
      }
      await env.client.claim({ session: env.session(), repo, issue });
      let routing: Routing;
      if (named) routing = asRouting(named, 'caller', port.now());
      else {
        const answer = await port.complete({ model: cfg.judge, prompt: routingPrompt(detail, cfg.tiers) });
        const fallback = cfg.tiers.find((t) => t.name === cfg.fallback)!;
        routing = 'text' in answer ? parseRouting(answer.text, cfg, port.now()) : { ...asRouting(fallback, 'judge', port.now()), confidence: 0, reason: `the judge did not answer (${answer.failed}); fell back to ${fallback.name}` };
      }
      const spawned = await port.spawn({
        subagentType: issueAgent(plugin, routing.effort),
        model: routing.model,
        description: `#${issue} ${detail.title}`.slice(0, 60),
        prompt: [`Issue ${key}: ${detail.title}`, detail.url, ...(input.context ? ['', input.context] : [])].join('\n'),
      });
      if (spawned.deny !== undefined || !spawned.agentId) {
        lines.push(`${key}: the agent did not start: ${spawned.deny ?? 'no agent id'}; it stays queued`);
        continue;
      }
      await env.client.claim({ session: env.session(), repo, issue, agent: spawned.agentId, routing });
      const low = routing.by === 'judge' && (routing.confidence ?? 0) < cfg.review;
      await env.client.decide({
        kind: 'routing',
        repo,
        issue,
        title: `#${issue} routed to ${routing.tier} (${routing.model}/${routing.effort})${low ? ', low confidence' : ''}`,
        body: [detail.title, routing.by === 'caller' ? 'tier named by the session' : `judge ${cfg.judge}, confidence ${(routing.confidence ?? 0).toFixed(2)}: ${routing.reason ?? ''}`, 'Answer with another tier to reroute.'].join('\n'),
        options: cfg.tiers.map((t) => t.name),
        blocking: false,
        from: { session: env.session() },
      });
      lines.push(`${key} → ${routing.tier} ${routing.model}/${routing.effort}, agent ${spawned.agentId}${routing.reason ? `: ${routing.reason}` : ''}`);
    } catch (e) {
      lines.push(`${key}: ${(e as Error).message}`);
    }
  }
  return lines.join('\n');
}

const ints = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? Number(x.replace('#', '')) : x)).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);

export function dispatchTool(plugin: string): Tool<DispatchPort> {
  return {
    name: 'dispatch',
    eager: true,
    mainOnly: true,
    description:
      'Start an issue agent on each issue, the only way to start one. Claims the issue for this session, routes it to a tier of model and effort (the routing judge reads the issue unless you name a tier, and every pick is logged for the person to review or override), and spawns the agent in the background. The agent resumes an existing branch and PR when there is one. Its progress arrives as work deliveries, and its final report arrives when it ends.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: { type: 'array', items: { type: 'number' } },
        repo: { type: 'string', description: 'owner/name; defaults to the session repository' },
        tier: { type: 'string', description: 'a routing tier by name, skipping the judge' },
        context: { type: 'string', description: 'what the agent should know beyond the issue: an answer to its question, a constraint, where to resume' },
      },
      required: ['issues'],
    },
    async run(env, input, _agent, port) {
      const issues = ints(input.issues);
      if (!issues.length) throw new HelmError(400, 'issues is required');
      const repo = typeof input.repo === 'string' && input.repo ? input.repo : undefined;
      if (repo !== undefined && !isRepoName(repo)) throw new HelmError(400, `repo ${repo} is not owner/name`);
      return dispatchIssues(env, port, plugin, {
        issues,
        ...(repo ? { repo } : {}),
        ...(typeof input.tier === 'string' && input.tier ? { tier: input.tier } : {}),
        ...(typeof input.context === 'string' && input.context ? { context: input.context } : {}),
      });
    },
  };
}
