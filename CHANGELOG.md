# Changelog

## 0.2.0

Hierarchy and dashboards.

- Epic tree from GitHub sub-issues, cross-repository, each node joined to its work item and rolled up over its leaves: done, active, in CI, ready, needing attention, queued and unowned. `view tree` reads it. Sub-issues are read again only when their parent moves.
- Agents report their plan with `report`, and each step's progress shows everywhere. Each work item keeps its phase history, and finished work is kept 30 days.
- A coordinator hears one `[helm epic]` delivery per epic whenever anything under it moves, in place of every child's phase change. Work that needs someone still arrives at once.
- Web dashboard with ten views: Overview, Board, Epics, Timeline, CI, Agents, Routing, Inbox, Repos and Activity. It has a work detail drawer, shared filters in the URL, a command palette, keyboard navigation, and validated phase colors in light and dark.
- The pane is a dashboard with Work, Epics, CI and Inbox tabs, plan and CI bars, and decision options answered in place.
- Fixes: a session working an issue itself counts as its worker (#23) and polls as active (#25), and a PR subscription made after CI settled hears the verdict (#26).

## 0.1.0

First release. helm replaces sift.

- helmd, one daemon per user: a shared GitHub poller with free ETag probes and a GraphQL snapshot, live CI jobs and steps, trimmed job logs, local worktrees and branches, and a persistent ledger of sessions, work, decisions and subscriptions.
- Work phases derived from agent reports, agent liveness, the issue's PR and its checks. Stalled work, stalled CI and failures on long-lived branches raise decisions that clear themselves.
- Event delivery to the subscribing session or subagent: on the next tool result, else by a message that resumes the agent, else relayed to the main loop. Each letter is delivered once.
- Tools: status, view, log, watch, report, backlog, dispatch, decide.
- dispatch routes each issue to a tier (model and effort) with a Haiku judge, logs the pick for review, and spawns the issue agent of that tier.
- Terminal pane, a band above the prompt and a status line.
- Web page on 127.0.0.1:7468 with the decision inbox, live fleet, repositories, activity and sessions.
- Role prompts for repository and coordinator sessions.
