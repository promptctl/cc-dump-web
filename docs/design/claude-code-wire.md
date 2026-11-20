# What Claude Code says on the wire about its agents

The column places each subagent from these facts and from nothing else (`packages/ui/src/format/wire.ts` reads them;
the formatter and `packages/ui/check/column.ts` both use it). The counts are from the recordings under
`~/.local/share/cc-dump/recordings/` except the two largest, taken through those readers on 2026-11-20, Claude Code
2.1.299: 411 requests from the main agent, 292 from subagents, 35 Agent calls, 6 Skill calls.

- **Who sent a request.** A subagent's request carries `x-claude-code-agent-id: <id>`, and
  `x-claude-code-parent-agent-id: <id>` when another subagent launched it (14 of the 292). The main agent's carry
  neither. A request's content says nothing reliable about its sender: Claude Code's title request resends the main
  thread's first message, and two agents launched with one prompt send the same first message.
- **The call that launched it.** A background Agent call's result arrives as the agent starts. Its first text opens
  `Async agent launched successfully.`, and its second line is `agentId: <id> (internal ID…` (35 results, one per Agent
  call). A foreground agent's result arrives when it returns: its report, then a last text `agentId: <id> (use
  SendMessage…` that ends with `<usage>…</usage>`. This frame comes from Claude Code 2.1.197's source, and no recording
  holds one. An Explore or Plan agent run in the foreground returns its report alone and names no agent.
- **A forked skill.** A Skill call whose skill forks runs it in a subagent. Its result says it launched
  (`Skill "<name>" launched (forked execution, running in the background)`) but names no agent, so only the
  agent's stop ties the two (20261117T061710.346Z.jsonl, agent a330dd041da201c30).
- **A stop.** When a background agent stops, the harness puts a `<task-notification>` in its caller's next request. It
  comes as a text block that is a single `<system-reminder>` and names the agent (`<task-id>`) and the call that
  launched it (`<tool-use-id>`): 19 stops. The caller's later requests resend it as history, and resends are not stops.
  A woken agent that stops again notifies again.
- **No stop at all.** An agent that ends its turn when its caller never takes another turn gets no notification (the
  ticket's measurement: on 20261118T112001.208Z.jsonl, agent a13f8cd5 launches 24 agents and never runs again). An
  agent therefore runs while one of its replies is still arriving, or while a reply stopped for a tool call that none
  of its later requests answers. The harness's "describe your most recent action" request resends the waiting step
  with no result, so it answers no call.
- **Unattached agents.** Some subagents' ids appear only on their own requests, with no result or notification that
  names them (20261117T143819.271Z.jsonl, ai-am-not-8dd11e05fc1c5df0; 20261118T092150.474Z.jsonl, three agents whose
  main thread sent no Agent call). They stay "not yet tied" at the end of their parent's thread.
