# helm

Active-work tracking for Claude Code fleets. helm watches GitHub and your local checkouts, keeps a ledger of which session and agent owns which issue, delivers repository events to the agent that asked for them, routes each issue to a model and effort, and shows all of it live, in the terminal and on a local web page with a decision inbox.

It is built for one way of working: a coordinator session, a session per repository that owns that repository's issues, and an issue agent per issue spawned by the repository session. Every piece is useful on its own too.

## Install

```
/plugin install helm --marketplace octalide/helm@main
```

or from a shell:

```sh
claude plugin marketplace add octalide/helm@main
claude plugin install helm@helm
```

helm is a function-hook plugin, which is early access. Turn on `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the `env` block of `settings.json`. It needs `node` 24 or newer and `gh` logged in (`gh auth login`). helmd uses the token gh holds and keeps none of its own.

## How it fits together

```
GitHub ──(etag probes, graphql)──┐
local git (worktrees, branches) ─┤
                                 ▼
                       helmd (one per user)
                 forge cache · ledger · subscriptions
                   │ unix socket          │ 127.0.0.1:7468
       ┌───────────┼───────────┐          ▼
   session      session     session    web page
 (coordinator)  (repo A)    (repo B)   live fleet, decision inbox
                  │ dispatch
            issue agents ── report, watch, view, log
```

**helmd** is the only process that talks to GitHub. The first session to need it starts it, and a session running a newer helm replaces an older one. It polls each repository in use: those a live session works in, those with unfinished work or a subscription, and any a tool asked about lately. Two conditional probes per poll cost nothing when nothing moved, and the snapshot (open and recent issues and PRs, every check on each PR head, last comment and review) is read only when a probe moved. Active repositories poll every 20 s, the rest every 3 minutes. Jobs and their steps are read live while a run is in flight. Everything helmd holds survives a restart.

**The mod** binds each session to helmd. It registers the session and its agents, streams the session's deliveries, serves the tools, draws the pane, and tells repository and coordinator sessions how to work with helm through a section of their system prompt, so no instruction file has to.

## Roles

A session in a repository is a **repo** session for it. Set the role with `HELM_ROLE=coordinator|repo|other` at launch, or with `/helm role coordinator`.

- **Repo session.** Owns a repository's issues. It queues them with `backlog`, starts agents with `dispatch`, and hears its own work move (`[helm work]` deliveries) without polling.
- **Coordinator.** Sees the fleet (`view` with `what: fleet` or `what: tree`), hears each epic's progress, every decision for the person and any work that needs someone, and talks to repository sessions with SendMessage.
- **Issue agent.** Started only by `dispatch`. It reports as it goes, its plan with each step's progress among it, waits on CI by subscribing and ending its turn, and stops with a question that goes to the session that owns its work, which answers it or escalates it to the person. The answer resumes it.

## Tools

| tool | does |
|---|---|
| `status` | this session's role, work, the decisions addressed to it and its own waiting on the person, subscriptions and letters in flight |
| `view` | work, fleet, tree (epics and sub-issues with progress rolled up), issues, issue, prs, pr (with live jobs), runs, worktrees, branches, decisions, sessions, from the shared cache |
| `log` | a CI job's log trimmed to its errors, a grep or a tail; or every failed job of a run |
| `watch` | subscribe to a repository, issue, PR, branch, run or tag. A subagent's subscription delivers to that subagent |
| `report` | where an agent's work stands: working (claims the issue), waiting, blocked with a question, ready, stopped, abandoned, plus its plan and choices made without the person, recorded for review |
| `dispatch` | start an issue agent per issue: claim, route to a tier, spawn, log the pick |
| `backlog` | the session's queue of issues |
| `decide` | list, answer, escalate to the person or dismiss decisions |

`/helm` shows the session's binding, and `/helm pane`, `/helm web`, `/helm role …` and `/helm restart` do what they say.

## Pane

`/helm pane` opens a dashboard beside the transcript, with four tabs. Each tab key works while the pane has the focus.

| key | tab | shows |
|---|---|---|
| `1` | Work | the session's work, or for a coordinator every session's: a bar of it by phase, then each item with its plan progress and next step, its checks with the running step or the failed checks, and its agent, tier and PR |
| `2` | Epics | each epic touching the session, with its percent, rollup bar and counts, and the work moving under it |
| `3` | CI | runs in flight with their job bar and running steps, then runs finished in the last half hour |
| `4` | Inbox | what is addressed to this session: its agents' questions and its stalls, and for a coordinator the person's decisions too; an option answers one in place, `escalate` hands it to the person and `dismiss` closes it. A written answer goes on the web page |

Above the prompt, one line appears while something needs you, and the status line counts work in progress.

## Delivery

Events reach whoever subscribed. A letter for the main loop rides the next tool result while a turn runs, or starts a turn when the session is idle. A letter for a subagent rides that agent's next tool call. After 60 s without one, or once the agent has ended its turn, it goes as a message that resumes the agent. If the engine refuses the message, the letter is relayed to the main loop and the agent's subscriptions are retired. helmd hands each letter out once.

CI arrives as one verdict per PR head (`ci settled success` or `failure`, naming each failed check with the run to read), one stall notice when checks have not finished within an hour, and run completions on branches and tags.

## Phases

Work moves through `queued → working → draft → ci → ready → done`, with `failing`, `blocked`, `stalled` and `parked` beside them. Phases are derived, not set: from the agent's reports, whether its agent is alive, the PR that closes the issue or sits on its branch, that PR's checks, and the issue's labels and dependencies. A stalled item (no live agent, work not done) and a stalled or failing CI raise a decision on their own, and clear it once the condition passes. A stall goes to the session that owns the work, and to the person once that session is gone, and a failing long-lived branch goes to the person. A dismissed one stays dismissed until its condition changes (a new PR head, a different agent, a different phase) or ends. Work set aside on purpose, labelled `blocked` or `parked` or blocked by an open issue, is `parked` while nobody is on it: it raises nothing and needs no attention. A report polls its repository at once, so the phase keeps up with what the agent just did.

## Hierarchy

GitHub's sub-issues draw the tree. Every open issue with sub-issues that no other issue in a watched repository holds is a root epic, and each node joins its work item: phase, agent, tier and plan progress. Sub-issues in other repositories nest under their parent, and a sub-epic in a repository helm does not poll is counted from its summary. Each epic rolls up its leaves: done, active, in CI, ready, needing attention, queued, parked and unowned. Sub-issues are read again only when their parent moved, or every 10 minutes.

Each work item keeps when it entered each phase, and finished work stays 30 days, so the page can draw a timeline. A coordinator hears an epic as one `[helm epic]` delivery whenever anything under it moves, carrying its rollup and every phase change under it in that batch, instead of a delivery per child. Work that needs someone still arrives at once.

When an issue agent's loop ends, helmd looks for live processes whose working directory is inside that work's worktree (Linux `/proc`, and a host without it reports nothing). What it finds goes on the work item as `leftovers` and to the owner as a `[helm work]` delivery tagged `leftovers`, shown in the pane and the drawer. Each local scan drops a listed process that has exited or left the worktree. helm never kills them: whoever owns the work decides.

## Routing

`dispatch` sends each issue to a **tier**: a model and an effort with a description of the work that belongs there. The judge (`claude-haiku-5-5` by default) reads the issue against the tiers and answers a tier, a confidence and a reason. Each pick is recorded for review, a record that waits on nobody, and answering it with another tier reroutes the issue. Name a tier in `dispatch` to skip the judge. A session registers an agent type for every tier and for the model and effort of every work item it owns, so an agent dispatched on a tier since removed can still be resumed. A session picks up a changed tier table on `/reload-plugins`.

The default tiers:

| tier | model | effort | for |
|---|---|---|---|
| mechanical | claude-haiku-5-5 | high | version and pin bumps, renames, moves, docs, pattern-following data rows, finishing a done PR, one-file fixes with a stated cause |
| light | claude-sonnet-5-5 | medium | small contained work in one module with a stated design |
| standard | claude-opus-5-5 | medium | ordinary work in one subsystem with clear acceptance |
| deep | claude-opus-5-5 | high | cross-subsystem or contract changes, codegen, concurrency, soundness, design-heavy work, unknown root causes |
| frontier | claude-fable-5-1 | high | reserved for decision-heavy work: architecture, contract or language design, research-grade problems, what earlier tiers failed on. Never an implementation workhorse |

A judge answer that names no tier falls back to `routing.fallback`, `standard` by default.

## Web page

`http://127.0.0.1:7468/`, or `/helm web`. It is a dashboard with a view per question, and each view updates live:

| view | shows |
|---|---|
| Overview | active work as the headline, tiles for what waits on you, what needs attention, what is in CI, ready and done this week; the attention queue, runs in flight, every epic's progress, the pipeline by phase, throughput per day and each session |
| Board | work as cards in phase columns (queued, working, draft, in ci, ready, attention, parked, done), each with its agent, tier, plan progress and checks; lanes by session, epic, repository or tier |
| Epics | the sub-issue tree across repositories, each epic with its rollup bar, each leaf with its phase, plan and agent; drill into any epic |
| Timeline | a lane per work item of the phases it went through over 6 hours to 30 days, and the median time work spends in each phase |
| CI | runs in flight with every job and step, pass rate and run length, each workflow's recent outcomes, and failed runs with their logs |
| Agents | each live session's agents, their model and effort, and the work each is on |
| Routing | picks per tier by outcome, the judge's confidence, and every pick with its reason |
| Inbox | what is yours to decide, each card marked for you: questions sessions hand on or ask themselves, stalls and failures nobody else owns, answered or dismissed in place. Below, muted and never counted, what sessions are handling, each naming its session, so you can read it or step in |
| Review | records of what was decided without you, newest first: choices agents and sessions made, which take feedback or are marked reviewed, and routing picks, which can still be rerouted |
| Repos | each repository's PRs, issues, runs, worktrees and branches, and the GitHub budget left |
| Activity | every event by day, by kind |

Clicking a work item opens its detail: its phases with how long each took, its plan, CI, routing, decisions and worktree. Filters for repository, session, epic and tier, plus a search, apply to every view and live in the URL, so a filtered view can be bookmarked. `ctrl k` opens a palette that jumps to any view, issue, epic, repository or session. The digits open the views and `r` opens Review, `/` searches, `j` and `k` walk the cards, `t` toggles the theme, and `?` lists the keys.

The page is served on 127.0.0.1 only. A request must name this server as its Host, and a write must come from this page.

## Config

`~/.config/helm/config.json`, every field optional:

```json
{
  "roots": ["~/dev/src"],
  "repos": ["owner/name"],
  "web": { "port": 7468 },
  "poll": { "active": 20, "idle": 180, "local": 15, "stallHours": 1, "goneSeconds": 120 },
  "routing": { "judge": "claude-haiku-5-5", "review": 0.7, "fallback": "standard", "tiers": [ ... ] }
}
```

`roots` are searched for checkouts by their `origin` remote. `repos` are polled whether or not anything references them. `routing.tiers` replaces the table whole, and `routing.fallback` must name one of its tiers. A repository can set its own `routing` in `.helm/config.json`.

helmd watches the file and applies an edit live, with no restart. An edit that fails to parse or check is logged to the daemon log and the running config kept.

State lives under `$XDG_STATE_HOME/helm` and the socket under `$XDG_RUNTIME_DIR/helm`. `HELM_HOME` puts everything under one directory, which is how a second daemon runs beside the real one.

## helmd

```
helmd start | stop | restart | status | serve | stream <session> | version
```

`bin/helmd` runs it from a checkout. Sessions start it on their own.

## Development

```sh
npm ci
npm run typecheck
npm test
claude plugin validate .
claude --plugin-dir .
```

The engine follows `$` into the hooks module alone, so everything that reaches the engine is in `hooks/helm.tsx`. Logic lives in plain modules under `src/mod` (the session side), `src/daemon` (helmd) and `src/core` (the contract both sides share).
