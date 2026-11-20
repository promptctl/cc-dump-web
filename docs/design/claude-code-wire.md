# What Claude Code states on the wire about its agents

Who sent a request, which call launched a subagent, and when a subagent stops are all stated by Claude Code, as ids. Nothing in cc-dump infers them from a prompt, a message's text or the order requests arrive in.

Read from Claude Code 2.1.299 (the installed binary, through `~/code/cc-extra/src/bun-graph.js`), with 2.1.88's source (`~/code/cc-source-study/reference-cc-2.1.88/anthropic_claude-code_original-source/src/tools/AgentTool/AgentTool.tsx`) for the structure the minified build keeps. Anchors in the binary are the strings quoted below; module names change every release.

## Request headers

Every request to the Messages API is built from the agent context of the code that sends it (the header builder holds `"x-claude-code-agent-id"`):

| Header | Sent | Says |
|---|---|---|
| `X-Claude-Code-Session-Id` | always | the session |
| `x-claude-code-agent-id` | every request of a subagent; never the main agent's | the agent's id, the same `agentId` its call's result and notification name |
| `x-claude-code-parent-agent-id` | a subagent launched by another subagent | the launching agent's id; absent when the main agent launched it |
| `x-claude-code-request-class` | only with the gate on (below) | `main`, `subagent`, `workflow`, `compaction`, `auxiliary` or `side_reply` |
| `x-claude-code-agent-type` | only with the gate on | the subagent's type: a built-in's name, `custom` or `teammate` |
| `x-claude-code-prompt-id` | only with the gate on | the user prompt the request serves |

The gate is `CLAUDE_CODE_GATEWAY_HINT_HEADERS` when set, else on for some first-party sessions behind a feature flag. None of the 15 recordings of 2026-11-15 to 18 carries the three gated headers. Claude Code launched by cc-dump can be given `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, so that what class a request is (a compaction, a side question, a title or topic request) is stated rather than read from its messages.

## An Agent call and the agent it launches

The agent's id is made before it runs (`createAgentId`) and goes three places, each naming the call by its `tool_use` id or the agent by its id:

1. **The call's result** (`tool_result` with the call's `tool_use_id`):
   - launched in the background: `Async agent launched successfully. … agentId: <id> …`, returned at once while the agent starts;
   - run in the foreground: the agent's report, then `agentId: <id> … <usage>…</usage>`, except a one-shot built-in (Explore, Plan) without a worktree, whose result is the report alone and names no agent.
2. **Each request the agent sends**: `x-claude-code-agent-id: <id>`.
3. **Its notification**, for a background agent, when it stops: `<task-notification>` with `<task-id><id></task-id>` and `<tool-use-id><the call's id></tool-use-id>`, in the caller's next request. It "fires each time this agent stops with no live background children of its own", so a woken agent notifies again.

So a nest holds the agent its call's result names, matched on the id. Where no wire fact names its call, its requests still say who it is and who launched it: a foreground one-shot agent, and a fork's worker, as `ai-am-not-8dd11e05fc1c5df0` on 20261117T143819.271Z.jsonl, which no result names.

Whether the model may run an agent in the foreground: the Agent tool offers `run_in_background` only while background tasks are on and the fork gate is off. In every recording the fork gate was on, the parameter was not offered, and every call ran in the background.

## When the name arrives

A background launch returns before the agent's first request is answered, so the caller's request carrying the result and the agent's first request race. On the recordings, a subagent launched by the main agent sends at most its first request before the result naming it is recorded; one launched by a subagent is named first. A request's place in the column can depend on a later request: when the name arrives, the agent's level moves under the call, and no step is read again.

## When a subagent stops

- background: its notification names it (`task-id`); woken again by a message, it runs until the next;
- foreground: its call's result is its report, delivered when it stops.
