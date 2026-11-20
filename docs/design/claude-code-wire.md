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

The `(use SendMessage …)` clause is left out when the agent cannot be continued. The trailer is either a text block of its own, or it follows a single-text report after a newline.

An Explore or Plan agent that ran without a worktree returns its report alone, so its result names no agent. No recording holds a foreground trailer, so this is read from the binary:

```sh
strings -n 6 ~/.local/share/claude/versions/2.1.299 | grep -n -e '<usage>subagent_tokens: ' -e '_0t=new Set'
```

A result that quotes either shape anywhere other than in these places names nothing.

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

Every later request of the caller resends the notification as history. In 20261117T143819.271Z, each of three agents' notifications is carried by more than 100 requests. So the stop is the first request in the recording to carry that text:

```sh
jq -r '[.body.messages[]?.content[]? | objects | select(.type == "text") | .text
  | select(test("^\\s*<system-reminder>\n") and test("<task-notification>"))
  | capture("<task-id>(?<id>[^<]+)</task-id>").id] | unique[]' requests.jsonl | sort | uniq -c | sort -rn
```
