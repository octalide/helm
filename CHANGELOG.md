# Changelog

## 0.5.0

- A repo session takes over the unfinished work its repository's gone sessions left: backlog order, claims, subscriptions, and the decisions that were theirs or went to the person only because they were gone. It hears one `[helm adopted]` delivery listing what to dispatch again. After a `/clear` or an in-process resume the old session id is handed over exactly (#81).
- A session starts or replaces helmd from the newest helm installed beside its mod that speaks its protocol, not from its own version, so whichever session starts it lands on the newest. `helmd restart` hands over without a gap: the new daemon takes the lock and the socket while the old one still answers (#79).

## 0.4.1

- The web page's Activity view lists events again. Links between views no longer carry one view's own parameters (the inbox's `kind` was filtering Activity to nothing), and the Repos view's repository tabs no longer narrow every other view (#64, #74).
- Board columns hold their width: attention cards no longer overflow into the next lane. Selects are drawn in the page's colors, open lists included (#64, #74).
- A CI wait fetches a PR head it has not seen (`pull/<n>/head`, so forks too) before judging whether it is the subscriber's, and delivers when it still cannot judge. A waiting agent whose verdict was held back for good reads as stalled instead of active (#65).
- An agent that reports `stopped` parks its work: no stall is raised, and what its subscriptions deliver goes to its session instead of waking it, until the issue is dispatched again, the agent reports `working`, or its session messages it (#68).
- A report from an agent the work has moved on from is refused (#75).

## 0.4.0

Every session needs `/reload-plugins` once: the protocol moves to 2.

- Every decision says who it is for. Your inbox and its badge count only what is yours. What agents ask their sessions shows below it under "for sessions", muted and never counted. A session answers its agents' questions, or escalates one to you. A gone session's decisions pass to you. Choices and routing picks are records, in a new Review view (#53).
- Deliveries to a busy main loop ride its tool results again, and letters that wait for a turn end go as one prompt, with a work item's stale phases folded into its newest. The cause was a module copy left running by a plugin reload: it took every letter and submitted each as its own prompt. A replaced copy now stands down (#58).
- A CI wait settles only on the head it waits on. `watch` takes the `sha` you pushed, and a verdict for an older head, or for a head from before a force push, is held back. Without a `sha`, the branch's pushed head is guessed and only a head strictly behind it is held (#55).
- When an issue agent ends, processes it left running in its worktree are reported on the work item and to its owner. helm never kills them. The issue prompt forbids shell backgrounding and wait loops (#61).
- A session's mod never replaces a newer helmd. One that speaks a newer protocol is logged as needing `/reload-plugins`. helmd creates its own lock directory (#69).
- Work dispatched before helm polled its issue carries the issue's title (#60).

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
