# Changelog

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
