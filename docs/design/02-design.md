# cc-dump: design

**Owner:** Brandon · **Status:** agreed 2026-11-14, one column 2026-11-16 · **Builds on:** `01-mvp.md`

The MVP works and looks like nothing: one weight, one gray, one typeface, the word "metadata" forty times an exchange. This document is the design the app is built to from here. It is driven by what the screen is for, then made handsome. It is built in tickets under the epic `dump-design-ajl`, in order: foundation, the conversation in time, minimap, keyboard.

## What the screen is for

The reader is watching an agent work, or reading a run after, and asks three questions: what just happened, what did the harness actually put in front of the model, and where in a long run am I. Every choice below serves one of those.

## Two axes

The web is a far more expressive canvas than a terminal, so the view uses its dimensions to say where the reader is.

- **Vertical is position within the conversation.** One column the width of the view, top the earliest content, bottom the most recent. Every row of the conversation at the moment shown is listed, none behind a count; a collapsed block's one line is what keeps a long run scannable.
- **Time is the turn strip's.** The strip above the conversation has a mark per step, the earliest at its left, and the conversation shown is the conversation as it was at the step chosen. A step is something arriving in the conversation: stepping forward in time adds it, stepping back removes it. Every exchange is an addition to the one conversation, a quota probe or a title request as much as a turn; none starts a conversation of its own. A request that resends a thread and goes its own way, a side question, a compaction, a prompt suggestion, a twin subagent, is a branch: an addition of its own, one step in, that never marks the thread's content changed.
- **What changed is a fact of the block.** A block says what was done to it where it stands, at the step that did it and at every step after. One the harness rewrote names the step of its last rewrite and opens, in place, to a diff of each rewrite it had: the lines taken out above the lines put in, the words that differ marked, runs of lines left as they were folded, and above them the block's name or category where the rewrite was of that. One taken away leaves one struck line where it stood, naming the step; where a branch does not send a block the line it left still sends, the branch's struck line is the name alone, the block being that line's to open and to search. A band at a row's left edge is for the step shown alone, in the color of what that step did to the row, so the step's own doing stands out from what is older.
- **Moving in time is one motion.** The conversation slides away the way the strip's steps run and the moment chosen comes in from the other side. Follow mode's moment is now.

The marks answer the first two questions at once: what the band marks is what just happened, and what the harness changed stays marked on the block it changed, however many steps ago.

## Principles

- **Color means category, or what Textual made it mean.** The category colors are the only hues the app adds to its theme. Every other color is a theme variable used for its Textual purpose: an error in `text-error`, a search match in the warning, a focus ring in `border`, the grounds and scrollbars as the theme sets them. A hue the theme does not define is always a category.
- **Two voices.** What the app says is set in a sans. What was on the wire, every byte of content, is set in a monospace face, verbatim, but for the conversation's prose: what a sender wrote (a message's text, the system prompt, thinking) is read as the model reads it, its Markdown rendered, its prose in the sans and its code in the mono, the same for every speaker; the heading and the gutter alone say who spoke. What a tool returned and what the proxy reports stay verbatim. The reader never wonders which is which.
- **Print what varies.** An exchange line prints the facts that differ between exchanges and nothing that repeats. A block line names the block usefully, with a preview of its content, not its category's name.
- **Hierarchy by weight, indent and ground, never boxes.** No cards, no borders around blocks, no shadows. Depth is Textual's three grounds: the app's chrome on `surface`, the conversation on `background`, what is raised (a button, a popover) on `panel`. An exchange boundary is its line, a band on `surface`.
- **One bold element.** The category gutter: a bar in the category's color at the left edge of every block row. Scrolling fast, the gutter alone shows the rhythm of a run. The filter bar is its legend. This is the original cc-dump's gutter, carried to the web.

## Themes

The themes are those `@promptctl/rich-js` ships (`themes/registry`), Textual's and Rich's terminal palettes (`default`, `svg-export`) alike: textual-dark, textual-light, nord, gruvbox, the catppuccins, dracula, tokyo-night, the solarizeds, the rose-pines, flexoki, monokai, atom-one and the rest. Every color on screen is a variable of the chosen theme, set once on the document root. The six category colors are derived from the theme as the original cc-dump derived its gutter and chip colors (`~/code/cc-dump/docs/THEME_COLOR_SYSTEM.md`), and placed as it placed them, in HSL, so that on textual-dark they are the colors the original showed: hues seeded in the widest gap the theme's own primary, secondary and accent hues leave, spread from the seed at the golden angle, and assigned in the original's order (tools, system, metadata, user, assistant, thinking), so an eye trained on it carries over; lightness in the theme's range. The contrast floors are then held by rich-js's contrast helper, which slides lightness and keeps the hue, in place of the original's per-hue correction loops. Adding a theme to rich-js adds it here with no change. With no choice made, the dark or light Textual theme follows the OS.

The app uses Textual's variable system whole, not a handful of its colors (https://textual.textualize.io/guide/design/). A theme is up to eleven base colors (primary, secondary, accent, foreground, background, surface, panel, success, warning, error, boost) and `dark`; from them Textual generates every variable, and rich-js's palette generates the same set. All of them are on the root under Textual's names, and each part of the app uses the variable Textual made for that purpose rather than a color of its own:

- **Shades:** `-lighten-1..3` and `-darken-1..3` of every base color.
- **Text:** `foreground` is legible on `background`, `surface` and `panel`; `foreground-muted` for what matters less, `foreground-disabled` for what cannot be used. `text-primary`, `text-secondary`, `text-accent`, `text-warning`, `text-error`, `text-success` are the base colors tinted to stay legible on those three grounds and on their own muted color. `text`, `text-muted`, `text-disabled` are black or white, whichever reads on the ground, for a ground that cannot be known ahead.
- **Muted:** `primary-muted`, `secondary-muted`, `accent-muted`, `warning-muted`, `error-muted`, `success-muted`: the base color blended into `background` at 70%; its `text-` color is legible on it.
- **Component variables:** border, block cursor and hover, input (cursor, selection), scrollbar, links, buttons, footer: the app's hairlines, hovers, selection, scrollbars, links and buttons are these, so a theme that overrides one in its `variables` changes it here as it does in Textual.

The category colors are app-specific variables in the same sense as Textual's own (`get_theme_variable_defaults`): derived from the base colors, held legible on the grounds they are drawn on, `background` and `surface`, with their chip text legible on the chip.

## Type

IBM Plex Sans for the app's voice; IBM Plex Mono for the wire. One superfamily, two clearly different voices that share a skeleton. Content wraps at about 110 characters whatever the window's width.

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ cc-dump  ● connected  1 in flight  last 4s ago     Recording ▾  Launch  Theme │
│ ▮ user  ▮ assistant  ▮ tools  ▮ system  ▮ thinking  ▮ usage …    search… 3/41 │
│ ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ▣  ·  ·     turn strip     │
├─────────────────────────────────────────────────────────────────────────┬──┬──┤
│  11  14:03:19  opus-5-5  2.1s  200                                      │▒▒│  │
│  in 46k  cache 44k  written 2k  out 390                                 │▒▒│  │
│  ▌▸ HTTP request                                                    929 │░░│  │
│┃ ▌▸ parameters                             rewritten at step 12   12.5k │▒▒│  │
│▸ TOOLS  95  Agent, Bash, Edit, Read…    Edit taken away at step 9  172k │░░│  │
│  USER                                                                   │░░│  │
│  ▌▾ text  proxy ok                                                    8 │░░│  │
│┃ 12  14:03:22  opus-5-5  3.4s  200                                      │▒▒│  │
│┃ in 48k  cache 46k  written 2k  out 812                                 │▒▒│  │
│┃ USER                                                                   │▒▒│  │
│┃ ▌▾ tool_result                                                     569 │▒▒│  │
│┃ ▌  <system-reminder> …                                                 │  │  │
│┃ ASSISTANT                                                              │  │  │
│┃ ▌▾ text  Reading…                                                  210 │  │  │
│                                                             ● Following │  │  │
└─────────────────────────────────────────────────────────────────────────┴──┴──┘
                                                                 minimap ─┘  └─ panels
```

Left-aligned throughout. The exchange line's facts sit in aligned columns, not joined by punctuation. Under it stands the exchange's envelope, with no heading, then each run of blocks under a heading that says whose it is (`01-mvp.md`, "Vocabulary"). The tool definitions are a set: `TOOLS` is their one line, closed here, which a click opens to a line each. The minimap is the vertical navigator, the turn strip, a mark per step in time, the horizontal one. The info, logs and keys panels (F8, F9, "Keys" below) open at the right.

## Keys

The app is driven from the keyboard, with the keys of the original where it has the act (`divergences.md`, "Presets and keys"). Every key is one line of one table, `packages/ui/src/view/keyboard.ts`: its chord, what it does, and its act. The listener, the keys panel and the controls' titles read that table, so this document does not list the keys: `?` does.

- **A key is heard in one of three places.** The conversation's keys and `?` are heard anywhere on the page outside a field. The search field hears its own three, Enter, Shift+Enter and Esc, and nothing else of the table: a character typed in a field, the terminal's among them, is typed.
- **A chord is written as it is read.** `N` is Shift with n and `?` is Shift with /, so Shift is said only with a key that types nothing (`Shift+Enter`). A press with Ctrl or Meta is the browser's, never a key of the table.
- **A key does what its control does.** `f` is a click on the follow control, a digit a click on the category in that place of the filter bar, an arrow a click on the turn strip's. A control with a key says it in its title.
- **A move by key is a reader's move.** `g`, `G`, `j`, `k` scroll, so they pause and resume following as the wheel does. Alt+N and Alt+P go to the next and the previous block the harness injected among the rows listed, counted from where the view is, and around the ends.
- **The keys panel is the help.** `?` opens it at the right, beside the conversation and not over it, so a key can be tried while its line is read. It stays open until it is put away, by `?` or its control in the header, and across a restart (F11).
