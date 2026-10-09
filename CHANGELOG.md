# Changelog

## 0.3.0

- Issue agents can be resumed again. helm's guard against the model starting an issue agent directly moved from `agent.offer`, which the engine also asks on a resume, to `agent.spawn`. Before, every issue agent that ended its turn to wait on CI or an answer was unreachable. A session also registers the agent type of every work item it owns, so an agent on a tier since removed keeps its type (#45).
- A new `parked` phase covers work set aside on purpose: labelled `blocked` or `parked`, or blocked by an open issue, with nobody on it. It raises no stall and needs no attention, and it is drawn in the pane and on the web page (#44).
- A dismissed stall or CI failure stays dismissed until its condition changes (a new PR head, a different agent, a different PR state) or ends (#44).
- A report polls its repository at once, so a phase no longer lags what the agent just did (#44).
- On a resume, the routing judge sees the PR, its CI, the last report and the plan, and prices the work that is left (#43).
- The default tiers are mechanical (haiku 5.5, high), light (sonnet 5.5, medium), standard (opus 5.5, medium), deep (opus 5.5, high) and frontier (fable 5.1, high), with frontier reserved for decision-heavy work. A `routing.fallback` that names no tier is refused. helmd applies an edited config.json live (#42).
- Issue agents put their worktree inside the repository, under `.claude/worktrees/<branch>` unless the repository says otherwise (#46).

## 0.2.3

- The web page's Activity view draws its events instead of `[object HTMLElement]`, and every view fills the page through one flattening helper (#39).

## 0.2.2

- An answer to a decision reaches the session that asked once, not twice (#36).

## 0.2.1

- Work that finished while helm was not watching is marked finished, dated when it closed, and work whose PR merged finishes as merged (#31).
- A PR subscription whose PR ended while helm was not watching retires (#33).

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
