# cc-dump: features

cc-dump is a web application that launches Claude Code in tmux, captures its Anthropic API traffic through a local proxy, and shows that traffic as a live, filterable, searchable conversation that is recorded and can be reopened.

## Vocabulary

| Term | Meaning |
|---|---|
| Agent | The coding tool being observed: Claude Code. |
| Proxy | The local HTTP endpoint the agent sends its API requests to. It forwards them to Anthropic. |
| Exchange | One API request and its response. |
| Block | One piece of an exchange: a system prompt, a text block, a tool call, a thinking block, a usage line. |
| Heading | The word over a run of an exchange's blocks, saying whose they are: `tools`, the tools the model is offered; `system`, its system prompt, and a message in the system's role; `user` and `assistant`, a message by who speaks, the reply as much as an assistant's message sent again; `message`, a message that is not the shape a message has. The exchange's envelope has no heading: it stands under the exchange's line. |
| Set | A heading's blocks that are one line while closed: the tool definitions, under `tools`. The heading is the set's line. |
| Category | The kind of content a block belongs to: user, assistant, tools, system, thinking, and the exchange's envelope by where it is from: parameters (what a request asks beside its prompt and messages, its cache breakpoints among them), usage (what the API reported about its reply: why it stopped, what it counted) and http (the wire as received: each side's head, a body or event not read, how the connection ended). |
| Conversation | The exchanges of one recording, in order, as shown on screen. |
| Recording | The stored file holding everything the proxy saw from one Claude Code process: one user session, from the process's start to its exit. Every request the process makes is in it, its quota probes, title requests and subagents' included, whatever session IDs they carry. Requests that name no process are in the proxy run's recording. |

## Features

### F1. Launch
- The user picks a tmux session from a list of the sessions on their tmux server and presses Launch.
- The app creates a new window in that session running the agent command, with `ANTHROPIC_BASE_URL` set to the proxy. The agent's first request appears in the conversation.
- The conversation shown is the launched process's recording, and only it.
- The agent command is a setting holding a full command line with its arguments, for example `claude --dangerously-skip-permissions`. Its default is `claude`.
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
- Each exchange is shown as one unit: its line, then its envelope, then what the request sends, then the reply.
- The envelope stands under the exchange's line with no heading: the request's HTTP headers, its model and parameters and its cache breakpoints, then the response's HTTP headers, the stop reason, and the token usage the API reported. Input is shown as its total, the uncached, cache-read and cache-written tokens together, with the cache read and the cache written beside it. An exchange cut short before any reply says how it ended here.
- What the request sends is the tool definitions under `tools`, the system prompt under `system`, and every message with its content blocks under who speaks, `user` or `assistant`.
- The reply is the response's content blocks under `assistant`, the heading the same content has when a later request sends it again as a message. An error that ended the exchange stands with the reply.
- A heading and the block under it do not say the same thing: a block of text is named `text` under whoever speaks.
- A thinking block that holds no text says only what the API reported, how long its signature is: it is usage, not thinking, so it is no row among what was said until the usage is shown.
- Content the harness injects into a user message is split out of it into blocks of its own, each named for what it is: a system reminder, hook output, the contents of a CLAUDE.md file named by its path.
- Every content block type has a rendering: text, thinking, redacted thinking, tool use, tool result, image, document, server tool use and its results.
- A block of a type the app does not know is shown under its type name as raw JSON. No block is ever dropped.

### F4. View
- The conversation scrolls. A response appears while it streams and settles into its final form when it completes.
- **Follow mode:** while on, the view stays at the newest content. Scrolling away pauses it and returning to the bottom resumes it. A control shows whether it is on, paused or off.
- **Expanding:** every block has a collapsed form (one line naming the block and its size) and an expanded form (all of its content). Clicking the block switches between them.
- A long region inside a block, such as a code fence or an XML-tagged section, collapses and expands the same way.
- A Markdown heading in a block's text is the line of what stands under it, up to the next heading of its depth or a shallower one: a click on the heading hides that, the deeper headings and what is under them with it, and a click shows it again. Closed, the line says how many lines it hides. What the user and the assistant said, and what the assistant thought, starts with all of it shown; the system prompt, a tool's description and the content the harness injects start with each heading closed, as their outline. What the user opened or closed stays that way.
- A Markdown text whose headings stand far apart has its contents above it: one line, closed until clicked, that opens to a list of every heading in the text, each set in under the heading it stands under, with how many lines stand under it. A click on an entry shows its heading, whatever was closed around it, and what stands under it, and puts the view there.
- A block starts collapsed or expanded as its category's level says (F5), except the content the harness injects (F3), which always starts collapsed. A block the user expanded or collapsed stays that way when its category's level changes.
- A set is one line while closed, and its blocks are listed under that line while open; a click on the line switches between them. The line says how many blocks the set holds, their names, as many as fit, and their size together, and the last thing a step did to one of them, so a tool a step rewrote or took away is found from the closed line. A set starts closed at its category's compact level and open at its expanded level, and one the user opened or closed stays that way when the level changes.

### F5. Filter
- Each category is set independently to one of three levels: hidden (its blocks are not listed), compact (each block is its collapsed line, and a set is its one line) or expanded (each block is expanded, and a set is open).
- The levels start as: user and assistant expanded; tools, system and thinking compact; parameters, usage and http hidden.
- A filter bar that is always on screen shows each category's level, telling the three apart. It is also the control that changes it: a click moves a category to the next level, from hidden to compact to expanded and back to hidden.

### F6. Search
- The user types a query and every match is highlighted as they type, with a count. Every category is searched, hidden ones included.
- The query is a regular expression, matched without regard to case. Each of case, whole word and regular expression can be switched.
- Next and previous move through the matches in order. Moving to a match inside a collapsed block or region expands it, moving to a match under a closed heading opens it, moving to a match in a closed set opens the set, and moving to a match in a hidden category shows its block.
- A text's contents (F4) are not searched: a match in a heading is counted once, where the heading is.

### F7. Record and reopen
- Every exchange is written to its process's recording as it happens, with no action from the user.
- A recording that was being written when the app crashed can still be opened.
- The user can pick any past recording from a list and read it with every feature in this document.
- A reopened recording and live traffic reach the screen through the same path. There is no second implementation for replay.
- Live capture keeps recording while the user reads another recording.

### F8. Status and info
- **Connection status,** always on screen: whether the browser is connected to the proxy, how many requests are in flight, and how long ago the last request arrived.
- **Info panel:** the proxy address, the `ANTHROPIC_BASE_URL=…` line to copy, which gives the agent started with it a recording of its own, the upstream address, the path of the current recording, the agent's session ID when the traffic carries one, the tmux session used for launching, and the app version. Every value can be copied with one click.

### F9. Logs panel
- A panel shows the log lines of the proxy and the app server as they are written, and can be filtered by level.

### F10. Themes
- The app ships with more than one theme, including a light one and a dark one. Switching takes effect immediately.
- Every color, including the category colors, comes from the theme. Adding a theme means adding one set of values and changing no component.

### F11. Settings persist
- These survive a restart of the browser, the app and the machine: the theme, each category's level, the search's case, whole-word and regular-expression switches, follow mode, which panels are open, the tmux session used for launching, the agent command, and the proxy port and upstream address.

### F12. Hot reload
- Saving a change to any source file except the proxy's takes effect in the running app without restarting the proxy.
- A request in flight during a reload completes for the agent and is recorded in full.
- After a reload the user sees the same conversation at the same scroll position, with the same filters, expanded blocks, search and follow state.
- A change to the proxy's own source does not take effect until the proxy restarts. The app shows that a proxy restart is pending.

### F13. Terminal
- The agent's tmux pane is shown in the page, beside the conversation, live and fully interactive: what the agent prints appears as it prints it, and what the user types goes to the agent, as in their own terminal.
- A launch (F1) shows the pane it opened.
- After a reload the pane is shown again as it is now.
- The terminal is put away and shown again by a control in the header, there while the launch's window is known, after a reload too. The agent runs on in its window either way.
- The terminal is in the theme (F10).
- It draws a statusline's Nerd Font icons and powerline separators from a face served with the app, and an emoji two cells wide, as tmux counts it (by Unicode 11's table). A link it prints, as a link or as a URL in its text, opens on a click: a web page in a new tab, any other scheme by the app the OS has for it. The pointer over a link shows where it goes.

## Architecture

**Three parts, one of which never reloads:**

| Part | Reloads | Does |
|---|---|---|
| Proxy process | Never | Forwards requests, removes secret headers from what it keeps, appends what it saw to its process's recording, every event as it arrived, lists the recordings, and serves a recording to readers from any position: one the proxy run is writing to its end and then live, any other to its end. Reads its port and upstream from its settings file at its start. |
| App server | Restarts on change | Launches agents through tmux, stores the settings it launches with, serves its log lines to the logs panel, as the proxy serves its own on its reader port (F9). |
| Browser UI | Hot module reload | Reassembles streamed responses into messages, formats them into blocks, filters, searches, displays. |

**The proxy knows nothing about messages, blocks or streaming events.** Everything that understands the Anthropic API lives in the parts that reload.

**One path to the screen.** The browser holds two kinds of state: the events it has read from the proxy, and the view settings of F11. Everything else on screen is derived from those two. Watching live traffic, reopening a past recording, refreshing the browser and reloading after a code change are one operation: read a recording from the start, then follow it.

**One connection interface.** The UI reaches the backend only through a single interface.

**One formatter.** A new block type or a richer rendering is one new entry in the formatter, with no change to capture or the view. Anything computed from traffic is another reader of the same events.

## Stack

- TypeScript throughout. Node for the proxy and the app server.
- React with Vite for the UI. Zustand for state.
- Tailwind, reading the theme's variables; no component library.
- tmux-control-mode-js for all tmux operations, and its terminal export, on xterm.js, for the terminal (F13).
