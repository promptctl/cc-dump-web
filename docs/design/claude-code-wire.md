# What Claude Code says on the wire about its agents

The app tells which agent sent a request, which call launched it, and when it stopped, from these facts alone (`packages/ui/src/format/wire.ts`). Each was read from Claude Code 2.1.299, which is the installed binary at `~/.local/share/claude/versions/2.1.299`, or from a recording in `~/.local/share/cc-dump/recordings/`.

The commands read a recording's requests as one JSON line each, `{trace, headers, body}`:

```sh
node packages/ui/check/requests.ts <recording.jsonl> > requests.jsonl
```

## Who sent a request

A subagent's request carries `x-claude-code-agent-id: <id>`. A subagent launched by another subagent also carries `x-claude-code-parent-agent-id: <id of that agent>`. A request of the main agent carries neither header.

A request is read as having no known sender when:
- its head was not recorded;
- it has a parent header but no agent header;
- a header repeats or is empty;
- its parent is itself.

In 20261117T143819.271Z, 112 requests carry no agent header. 14 agents send the rest, and three of those name a6787ff8b38e6890b as their parent:

```sh
jq -r '([.headers[] | select(.[0] | ascii_downcase == "x-claude-code-agent-id") | .[1]] | first // "main") as $a
  | ([.headers[] | select(.[0] | ascii_downcase == "x-claude-code-parent-agent-id") | .[1]] | first // "-") as $p
  | "\($a) \($p)"' requests.jsonl | sort | uniq -c
```

## The call that launched an agent

The Agent tool's result names the agent it launched, in one of two shapes.

**Background launch.** Its first text begins:

```
Async agent launched successfully.<rest of the line>
agentId: <id> (internal ID
```

In 20261117T143819.271Z, 13 agents are named this way:

```sh
jq -r '.body.messages[]?.content[]? | objects | select(.type == "tool_result") | .content
  | if type == "array" then .[0].text? else . end | strings
  | select(startswith("Async agent launched successfully."))
  | capture("\nagentId: (?<id>[\\w-]+) \\(internal ID").id' requests.jsonl | sort -u
```

**Foreground agent that returns.** Its last text ends with this trailer:

```
agentId: <id> (use SendMessage …)
<worktree lines, when the agent ran in a worktree>
<usage>subagent_tokens: N
tool_uses: N
duration_ms: N</usage>
```

The `(use SendMessage …)` clause is left out when the agent cannot be continued. The trailer is either a text block of its own, or it follows a single-text report after a newline. Its `agentId:` line is the last one in the text, so a report that quotes another agent's id names that agent nowhere.

An Explore or Plan agent that ran without a worktree returns its report alone, so its result names no agent. No recording holds a foreground trailer, so this is read from the binary:

```sh
strings -n 6 ~/.local/share/claude/versions/2.1.299 | grep -n -e '<usage>subagent_tokens: ' -e '_0t=new Set'
```

A result that quotes either shape anywhere other than in these places names nothing, and only a result of an Agent call names an agent at all.

## That an agent stopped

The harness tells the caller with a text block that is wholly one `<system-reminder>` holding a `<task-notification>`. It holds:
- `<task-id>`, the agent's id;
- `<status>`, such as `completed` or `killed`;
- `<tool-use-id>`, the call that launched the agent, where the harness knows it.

In 20261118T092150.474Z, none of the 3 agents' notifications has a `<tool-use-id>`. Those agents were launched before the recording began:

```sh
jq -r '.body.messages[]?.content[]? | objects | select(.type == "text") | .text
  | select(test("^\\s*<system-reminder>\n") and test("<task-notification>"))
  | (capture("<task-id>(?<id>[^<]+)</task-id>").id) + " " + ((capture("<tool-use-id>(?<c>[^<]+)</tool-use-id>").c) // "none")' requests.jsonl | sort -u
```

Every later request of the caller resends the notification as history. In 20261117T143819.271Z, each of three agents' notifications is carried by more than 100 requests. So a stop is the request that first sends the notification in its history; a request that resends it there states nothing again, and a woken agent's next notification is a text block of its own, a new stop whatever it says:

```sh
jq -r '[.body.messages[]?.content[]? | objects | select(.type == "text") | .text
  | select(test("^\\s*<system-reminder>\n") and test("<task-notification>"))
  | capture("<task-id>(?<id>[^<]+)</task-id>").id] | unique[]' requests.jsonl | sort | uniq -c | sort -rn
```

## What an agent is doing

While a subagent works, Claude Code asks it every 30 seconds to describe its latest action in a few words (`services/AgentSummary/agentSummary.ts` in `~/code/cc-source-study/reference-cc-2.1.88`; the same code is in 2.1.299). The request carries the subagent's own `x-claude-code-agent-id`, and through cc-dump no header marks it: `x-claude-code-request-class: auxiliary` is sent only when the base URL is `api.anthropic.com`. It resends the subagent's messages without the reply that waits on a tool, so the question is appended to the last result, and the request stands beside the agent's next step. Its reply is the agent's own account of what it is doing, and like any step it runs only while it streams. In 20261117T143819.271Z, 9 such requests come from 5 agents:

```sh
jq -r 'select(.headers != null) | select(.body.messages[-1].content | type == "array")
  | select(.body.messages[-1].content[-1].text? // "" | test("^Describe your most recent action"; "m"))
  | (.headers[] | select(.[0] == "x-claude-code-agent-id") | .[1])' requests.jsonl | sort | uniq -c
```
