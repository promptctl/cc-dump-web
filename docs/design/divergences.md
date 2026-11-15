# cc-dump-web: divergences from cc-dump

**For:** Brandon, reviewed 2026-11-14 · **Compared:** cc-dump at `~/code/cc-dump` (code, not only its docs) against `00-premise.md`, `01-mvp.md`, `02-design.md` and `packages/` as of 2026-11-14.

cc-dump paths are relative to `~/code/cc-dump`; cc-dump-web paths to this repo. Proposals are mine.

## Core: monitoring a session

### 1. A recording is everything one proxy run saw (being fixed: dump-mvp-v3s.jhz)

- **cc-dump:** one cc-dump instance watches one agent. Its launch key focuses the agent pane it already has, or adopts a sibling `claude` pane, rather than starting a second (`src/cc_dump/app/tmux_controller.py`). When the session ID in `metadata.user_id` changes, it writes a NEW SESSION block at the boundary (`src/cc_dump/core/formatting_impl.py`), and `{` / `}` jump between those boundaries. The code does not split recordings or tabs by session: every Anthropic session goes to the one default tab (`src/cc_dump/tui/app.py`, asserted by `tests/test_multi_session_tabs.py`), and there is one HAR per provider per run (`src/cc_dump/pipeline/har_recorder.py`). In practice, one run holds one session because the app never launches a second one.
- **cc-dump-web:** a recording is "everything the proxy saw for one run" (`01-mvp.md`, Vocabulary; `packages/proxy/src/recording.ts`). The proxy never restarts, and every Launch adds another agent (F1), so each new agent is appended to the conversation already on screen, with no boundary marked.
- **Why it matters:** the reader cannot tell which agent produced an exchange, or where one session ends and the next begins.
- **Ruling (Brandon, 2026-11-14):** A recording is one Claude Code process, one user session: everything it sends, whatever session IDs it carries. Managing several processes may come later; the process is the unit. (`01-mvp.md`, Vocabulary.)

### 2. The side-by-side view pairs exchanges that are not versions of one document

- **cc-dump:** shows every exchange of the run in one continuous scroll, in arrival order, each one complete on its own (`src/cc_dump/tui/widget_factory.py`, ConversationView). It never compares one exchange against another; system prompt tracking is explicitly absent (`src/cc_dump/core/formatting_impl.py`, "no cross-request tracking").
- **cc-dump-web:** the main view shows "two consecutive turns side by side, aligned block by block like a side-by-side diff", and follow mode's pair is "the newest turn and the one before it" (`02-design.md`, "Two axes"). The rest of the run is reached through the turn strip, one pair at a time.
- **Why it matters:** in one Claude Code session, consecutive exchanges are often not the same conversation. jhz's own evidence shows that a session's quota probe, its title request (a different model and system prompt) and its turns all carry the same session ID. Subagent requests carry it too, and they interleave with the main agent's and overlap in time. Diffing a main turn against the subagent or title request just before it marks nearly everything as changed. The design's own claim, "what is new on the right is what just happened", is then false. Paging pairs also replaces cc-dump's scroll through the whole session, which is how a reader takes in a run.
- **Ruling (Brandon, 2026-11-14):** The view compares the entire conversation at two moments, not one request with another. A quota probe is an addition to the conversation, not a new one. The view moves back and forward in time, adding items to and removing them from the conversation. (`02-design.md`, "Two axes".)

### 3. The exchange line's token counts misreport input and drop cache writes

- **cc-dump:** usage shows total input, which is fresh plus cache read plus cache created. Next to it are the percentage cached, then a cache read / created / fresh breakdown and a cost estimate (`src/cc_dump/tui/rendering_impl.py`, the response usage renderers; `src/cc_dump/core/analysis.py`, `compute_session_cost`). Each section of the request is marked cached, cache write or fresh (`compute_cache_zones`, same file).
- **cc-dump-web:** the line prints `in` = `usage.input_tokens`, `cache` = `cache_read_input_tokens`, and `out` (`packages/ui/src/format/format.ts`, `messageBlocks`; `packages/ui/src/view/Conversation.tsx`). `cache_creation_input_tokens` is not read. With caching on, `input_tokens` is only the uncached remainder, often single digits. The mock in `02-design.md` ("in 46.1k cache 44k") shows a total that the code does not compute.
- **Why it matters:** a reader watching context growth or cache behavior sees a tiny "in" and no cache writes, which is wrong on every cached turn.
- **Ruling (Brandon, 2026-11-14):** Not important yet; the spec states the counts accurately. (`01-mvp.md`, F3.)

### 4. Search finds only what is shown, and only literal text

- **cc-dump:** search covers every category, hidden ones included, and moving to a match reveals its block even when its category is hidden (`src/cc_dump/tui/view_overrides.py`, `set_search_reveal`; `src/cc_dump/tui/search_controller.py`). It is regex and case-insensitive by default, and incremental (`src/cc_dump/tui/search.py`).
- **cc-dump-web:** search covers "every match in the shown categories" (F6; `packages/ui/src/view/search.ts`). Regex, case options and "search inside hidden categories" are listed under "Not in the MVP" (`01-mvp.md`).
- **Why it matters:** a reader hunting for a tool name or a reminder in metadata, tools or system has to know where it lives and unhide that category first. cc-dump's search exists so they do not have to.
- **Ruling (Brandon, 2026-11-14):** cc-dump's behavior is correct, and is the spec. (`01-mvp.md`, F6.)

### 5. Launching again starts a new session instead of resuming the watched one

- **cc-dump:** Claude's launch option `auto_resume` defaults to on and passes `--resume <session id>` of the session being watched (`src/cc_dump/app/launch_config.py`; `src/cc_dump/tui/settings_launch_controller.py`). When the agent exits, launching again continues the same conversation in the same view.
- **cc-dump-web:** a launch runs the stored command (F1). jhz's plan appends `--session-id <new uuid>` to every launch, so each one is a new session, and there is no launch that resumes one.
- **Why it matters:** the agent exits or crashes mid-session, the user relaunches from the app, and lands in a fresh session with an empty view.
- **Ruling (Brandon, 2026-11-14):** An open question until the basics of how the app works are settled. (`01-mvp.md`, Open issues.)

### 6. A tool result does not name its tool

- **cc-dump:** each `tool_result` is linked to its `tool_use` by ID and shows the tool's name, its detail (the file path, command or pattern) and a color shared with the call (`src/cc_dump/core/formatting_impl.py`, `tool_id_map`; `src/cc_dump/core/analysis.py`, `correlate_tools`).
- **cc-dump-web:** a result is named `tool_result` and shows its `tool_use_id` (`packages/ui/src/format/blocks.ts`). "Per-tool renderers" are out of the MVP, but this linking is a separate thing.
- **Why it matters:** in a long request history, the reader sees dozens of results named `tool_result`, and can find out which tool each came from only by matching IDs by hand.
- **Ruling (Brandon, 2026-11-14):** Not needed now, but the spec names it. (`01-mvp.md`, "Not in the MVP".)

### 7. Injected content is not named or navigable

- **cc-dump:** user text is split into its parts. `<system-reminder>` and hook output become named hook blocks, and "Contents of … CLAUDE.md" becomes a config block named for its file (`src/cc_dump/core/formatting_impl.py`). Markers for CLAUDE.md, hooks, skills and the tool list can be jumped between with Alt+N / Alt+P (`src/cc_dump/core/special_content.py`; `src/cc_dump/tui/location_navigation.py`).
- **cc-dump-web:** "splitting injected content out of user messages" is not in the MVP (`01-mvp.md`). XML-tagged regions inside a block collapse (F4), but they are neither named nor reachable by jumping.
- **Why it matters:** the premise names "the content the harness injects" as the point of the app (`00-premise.md`). In cc-dump that content is labeled and one key away; here it is unlabeled text inside a user block.
- **Ruling (Brandon, 2026-11-14):** Required. (`01-mvp.md`, F3.)

### 8. No session totals

- **cc-dump:** the stats panel shows turn count, total tokens, the input/output/cache breakdown, cache hit percentage and savings, and cost. Its other views are a per-turn timeline with a sparkline and a per-model table (`src/cc_dump/tui/panel_renderers.py`; `src/cc_dump/app/analytics_store.py`). The README sells "token costs" as part of watching a session.
- **cc-dump-web:** only per-exchange counts appear, on the exchange line. Token-cost figures are not in the MVP (`01-mvp.md`, "Not in the MVP").
- **Why it matters:** "how much has this session used, and is the cache working" is a monitoring question, and cc-dump answers it at a glance.
- **Ruling (Brandon, 2026-11-14):** Unimportant.

### 9. cc-dump's recordings do not open

- **cc-dump:** recordings are HAR 1.2 files in `~/.local/share/cc-dump/recordings/` (`src/cc_dump/pipeline/har_recorder.py`), replayed through the live path (`src/cc_dump/pipeline/har_replayer.py`).
- **cc-dump-web:** recordings are wire-event JSONL, and "the old app's recordings will not open" (`01-mvp.md`, Open issues; `packages/proxy/src/format.ts`).
- **Why it matters:** sessions a user already recorded with cc-dump cannot be read in its replacement.
- **Ruling (Brandon, 2026-11-14):** The wire format stands for its reason: a reopened recording is read by the same path as live traffic and reaches the same state, which cc-dump's HAR, a non-streaming summary of each exchange, does not. (`01-mvp.md`, Open issues.)

## Display and behavior: deliberate or harmless

- **Detail levels and defaults.** cc-dump has three levels (existence, summary, full). Its defaults are metadata hidden; tools, system and thinking at summary; and consecutive tool pairs folded into "Read 2x Bash 1x" (`src/cc_dump/core/filter_registry.py`). cc-dump-web has shown/hidden plus expand, and starts every category shown, with all but user and assistant collapsed (F4, F5).
- **Presets and keys.** cc-dump's filterset presets (`=` / `-`) and vim keys have no counterpart yet. The keyboard is the fourth design ticket.
- **Where the agent runs.** cc-dump splits a pane below itself and adopts an existing `claude` pane. cc-dump-web opens a window in a chosen tmux session, allows many agents, and shows the pane in the page (F1, F13). This is a superset once jhz keeps sessions apart.
- **"Connected".** In cc-dump it means a request arrived in the last 120 s, i.e. the agent is active (`src/cc_dump/tui/session_panel.py`). In cc-dump-web it means the browser reaches the proxy, with request age shown beside it (F8).
- **Capture scope.** cc-dump treats any path starting with `/v1/messages` as API traffic, so `count_tokens` is captured despite its spec (`src/cc_dump/pipeline/proxy_call.py`). cc-dump-web shows only `POST /v1/messages` and records every path's bytes. cc-dump drops exchanges that never complete; cc-dump-web keeps them.
- **Recording shape.** cc-dump stores synthetic non-streaming entries with `stream: false`. cc-dump-web stores the wire as it was.
- **Streaming.** cc-dump previews only one focused stream's text deltas (`src/cc_dump/app/domain_store.py`). cc-dump-web reassembles every in-flight stream in full, and shows response tool calls with their input, where cc-dump shows the name only.
- **System prompt diffing.** cc-dump has none. The diff in `02-design.md` is new. Item 2 covers only what it pairs.
- **Providers and proxy modes.** cc-dump also proxies OpenAI and Copilot, including a TLS forward proxy. cc-dump-web is Anthropic only.
- **`$$` sentinel.** cc-dump answers a user message starting with `$$` itself, as `[cc-dump]`, and focuses its pane (`src/cc_dump/pipeline/sentinel.py`). cc-dump-web forwards every byte unchanged (F2).
- **Export and recording admin.** cc-dump has "Dump conversation", `--list-recordings`, `--cleanup-recordings`, and a cap of 5000 turns in memory. cc-dump-web has none of these.
- **Replay then live.** cc-dump's `--resume` / `--continue` replay a HAR, then keep capturing into a new file in the same view. cc-dump-web reads a past recording while live capture continues, and under jhz a resumed session extends its own recording.
