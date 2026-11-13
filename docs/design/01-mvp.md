# cc-dump: MVP scope

**Owner:** Brandon · **Status:** draft, scope set by Brandon 2026-11-12 · **Builds on:** `00-premise.md`

The MVP is a web application that launches Claude Code in tmux, captures its Anthropic API traffic through a local proxy, and shows that traffic as a live, filterable, searchable conversation that is recorded and can be reopened. It is a from-scratch rewrite of the Python/Textual cc-dump; nothing here is required to match the old app's behavior.

## Vocabulary

| Term | Meaning |
|---|---|
| Agent | The coding tool being observed. In the MVP, Claude Code. |
| Proxy | The local HTTP endpoint the agent sends its API requests to. It forwards them to Anthropic. |
| Exchange | One API request and its response. |
| Block | One piece of an exchange: a system prompt, a text block, a tool call, a thinking block, a usage line. |
| Category | The kind of content a block belongs to: user, assistant, tools, system, metadata, thinking. |
| Conversation | The exchanges of one recording, in order, as shown on screen. |
| Recording | The stored file holding everything the proxy saw for one run. |

## Features

Each feature is stated as what the person using the app can do and see.

### F1. Launch
- The user picks a tmux session from a list of the sessions on their tmux server and presses Launch.
- The app creates a new window in that session running the agent command, with `ANTHROPIC_BASE_URL` set to the proxy. The agent's first request appears in the conversation.
- The agent command is a setting. Its default is `claude`.
- When tmux has no running server or no sessions, the launch control says so. When tmux refuses the launch, the user sees tmux's error text.
- An agent started by hand also works: the info panel (F8) gives the line to export.

### F2. Capture
- Every request to the Anthropic Messages API, streaming or not, is captured with its response.
- The agent receives response bytes as they arrive from Anthropic. The request body reaches Anthropic byte-for-byte as the agent sent it.
- Requests to any other path are forwarded and not shown.
- Requests that overlap in time are kept as separate exchanges.
- Failures are captured as exchanges: an HTTP error with its body, an error event in the middle of a stream, and a failed connection to Anthropic.
- Every block type is captured, including types the app has never seen. The proxy records what was on the wire and does not interpret it.
- The `authorization`, `x-api-key`, `cookie` and `set-cookie` headers are forwarded but never written to a recording and never sent to the browser.

### F3. Format
- Each exchange is shown as one unit: the request, then its response.
- The request shows the model and parameters, the HTTP headers, the tool definitions, the system prompt, and every message with its content blocks.
- The response shows its content blocks, the stop reason, and the token usage the API reported.
- Every content block type has a rendering: text, thinking, redacted thinking, tool use, tool result, image, document, server tool use and its results.
- A block of a type the app does not know is shown under its type name as raw JSON. No block is ever dropped.

### F4. View
- The conversation scrolls. A response appears while it streams and settles into its final form when it completes.
- **Follow mode:** while on, the view stays at the newest content. Scrolling away pauses it and returning to the bottom resumes it. A control shows whether it is on, paused or off.
- **Expanding:** every block has a collapsed form (one line naming the block and its size) and an expanded form (all of its content). Clicking the block switches between them.
- A long region inside a block, such as a code fence or an XML-tagged section, collapses and expands the same way.
- Blocks in the user and assistant categories start expanded. Blocks in the other categories start collapsed.

### F5. Filter
- Each of the six categories can be shown or hidden independently.
- A filter bar that is always on screen shows each category's current state. It is also the control that changes it.

### F6. Search
- The user types a query and every match in the shown categories is highlighted, with a count.
- Next and previous move through the matches in order. Moving to a match inside a collapsed block or region expands it.

### F7. Record and reopen
- Every exchange is written to the recording as it happens, with no action from the user.
- A recording that was being written when the app crashed can still be opened.
- The user can pick any past recording from a list and read it with every feature in this document.
- A reopened recording and live traffic reach the screen through the same path. There is no second implementation for replay.
- Live capture keeps recording while the user reads a past recording.

### F8. Status and info
- **Connection status,** always on screen: whether the browser is connected to the proxy, how many requests are in flight, and how long ago the last request arrived.
- **Info panel:** the proxy address, the `ANTHROPIC_BASE_URL=…` line to copy, the upstream address, the path of the current recording, the agent's session ID when the traffic carries one, the tmux session used for launching, and the app version. Every value can be copied with one click.

### F9. Logs panel
- A panel shows the log lines of the proxy and the app server as they are written, and can be filtered by level.

### F10. Themes
- The app ships with more than one theme, including a light one and a dark one. Switching takes effect immediately.
- Every color, including the six category colors, comes from the theme. Adding a theme means adding one set of values and changing no component.

### F11. Settings persist
- These survive a restart of the browser, the app and the machine: the theme, each category's shown or hidden state, follow mode, which panels are open, the tmux session used for launching, the agent command, and the proxy port and upstream address.

### F12. Hot reload
- Saving a change to any source file except the proxy's takes effect in the running app without restarting the proxy.
- A request in flight during a reload completes for the agent and is recorded in full.
- After a reload the user sees the same conversation at the same scroll position, with the same filters, expanded blocks, search and follow state.
- A change to the proxy's own source does not take effect until the proxy restarts. The app shows that a proxy restart is pending.

## How hot reload shapes the design

Hot reload is designed in first, because it decides where every other piece lives.

**Three parts, one of which never reloads:**

| Part | Reloads | Does |
|---|---|---|
| Proxy process | Never | Forwards requests, removes secret headers from what it keeps, appends what it saw to the recording, and serves the recording to readers from any position, then live. |
| App server | Restarts on change | Launches agents through tmux (using tmux-control-mode-js), lists recordings, stores settings, relays logs. |
| Browser UI | Hot module reload | Reassembles streamed responses into messages, formats them into blocks, filters, searches, displays. |

**The proxy stays small so that it rarely changes.** It knows nothing about messages, blocks or streaming events. Everything that understands the Anthropic API lives where it can be reloaded. This is also what makes "every block type is captured" true by construction: the proxy cannot drop what it never parses.

**One path to the screen.** The browser holds two kinds of state: the events it has read from the proxy, and the view settings of F11. Everything else on screen is derived from those two. So these four cases are the same operation, which is to read a recording from the start and then follow it:

- watching live traffic,
- reopening a past recording,
- refreshing the browser,
- reloading after a code change.

**Both servers listen on 127.0.0.1 only.** Recordings contain the user's prompts and code.

## Stack

- TypeScript throughout. Node for the proxy and the app server.
- React with Vite for the UI. Zustand for state.
- Tailwind with theme values as CSS variables, and shadcn/ui for components.
- tmux-control-mode-js for all tmux operations.

## Not in the MVP

- **A terminal in the browser.** Showing the agent's tmux pane in the page with xterm.js is wanted later and is not required now. The agent is used in the user's own terminal.
- Detail levels beyond shown and hidden, search options (regex, case, whole word), search inside hidden categories, per-tool renderers, markdown rendering, splitting injected content out of user messages, and token-cost figures. These were proposed as the next layer and are not part of this scope.
- Everything in the intermediate and advanced layers.

## Open issues

| Item | Type |
|---|---|
| The recording holds what was on the wire, so it is not a HAR file and the old app's recordings will not open. | question |
| Re-deriving a very long conversation on every reload may be slow. Not measured. | risk |
| The session ID in the info panel depends on Claude Code's `metadata.user_id` format, which is unofficial. Not checked against the current Claude Code. | risk |
| Shell aliases for the agent command (such as `clod`) do not resolve in a tmux window command without sourcing the shell's rc file. | question |
