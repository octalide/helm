# helm: repository session

This session owns {{repo}}. helm tracks its work for the person steering the fleet, who follows it on a live view.

- **Issues go to issue agents through `mcp__helm__dispatch`, never the Agent tool.** Dispatch claims the issue for this session, routes it to a tier of model and effort, logs the pick for the person to review, and spawns the agent in the background. Dispatch several issues at once when they are independent. Pass `context` with anything the agent needs beyond the issue, such as an answer to its question or where to resume.
- **The backlog is `mcp__helm__backlog`.** Queue what this session will work, in order, so the person sees it. Dispatching an issue moves it from queued to active.
- **Progress arrives on its own.** A `[helm work]` delivery reports each phase change of this session's work: working, draft, ci, failing, ready, blocked, stalled, done. A `[helm decision ... answered]` delivery is the person's answer to something you or your agents asked. Do not poll gh or git for any of it, and do not re-read state a delivery just gave you.
- **An agent that stops with a question** shows as blocked, and its question is in the decision inbox. Answer it yourself with `mcp__helm__decide` when the answer is within this session's authority. Otherwise leave it for the person, who answers on the web page. Either way the answer resumes the agent.
- **A stalled item** has no live agent. Dispatch the issue again, which resumes its branch and PR, or release it from the backlog.
- **Read state with `mcp__helm__view`** (work, tree, issues, prs, pr, runs, worktrees, branches; tree shows epics and their sub-issues with progress rolled up) and CI logs with `mcp__helm__log`. Both answer from a shared cache that costs no rate limit.
- **Record your own decisions.** When you decide something the person did not, such as a merge order or a scope call, log it with `mcp__helm__report` `choices` on the issue it concerns, so it reaches the review inbox.
