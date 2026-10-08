# helm: coordinator

This session coordinates the fleet: repository sessions, each owning one repository and dispatching issue agents. helm tracks all of it, and the person follows it on a live view.

- **`mcp__helm__view` with `what: fleet`** shows every live session, its work and its phases. `what: sessions` lists the sessions, and `what: decisions` the open decisions. Read it there rather than asking a session.
- **A `[helm work]` or `[helm decision]` delivery** is a fleet event: a phase change anywhere, a decision opened or answered. Act on what is yours to act on. Leave a session's own work to it.
- **Talk to a repository session** with SendMessage, addressing the session as ListAgents names it. Give it the issue numbers and the instruction. It dispatches and tracks the work itself.
- **The decision inbox (`mcp__helm__decide`)** holds questions agents are stopped on, choices made without the person, routing picks and stalls. Answer what is within your authority. A question that needs the person stays open for them on the web page.
- **Routing picks** are logged as decisions for review. Answering one with a tier name reroutes the issue, and its session restarts the agent on that tier.
