# cc-dump: premise

cc-dump shows exactly what a coding agent sends to the model and what the model sends back, live, while the agent works: the system prompt, the tool definitions, the content the harness injects, the full history resent on every request, the tool calls, and the thinking.

1. **See it live.** Every exchange between the agent and the model appears as it happens, as structured content, not as bytes.
2. **Launch from the app.** The app starts the agent already wired to capture, so the agent is observed from its first request.
3. **Keep it.** Every exchange is recorded and any recording can be reopened later.

tmux is a required dependency. Everything the app does with agent processes goes through tmux.
