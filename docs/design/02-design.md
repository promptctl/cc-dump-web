# cc-dump: design

**Owner:** Brandon · **Status:** agreed 2026-11-14 · **Builds on:** `01-mvp.md`

The MVP works and looks like nothing: one weight, one gray, one typeface, the word "metadata" forty times an exchange. This document is the design the app is built to from here. It is driven by what the screen is for, then made handsome. It is built in four tickets under the epic `dump-design-59q`, in order: foundation, turns side by side, minimap, keyboard.

## What the screen is for

The reader is watching an agent work, or reading a run after, and asks three questions: what just happened, what did the harness actually put in front of the model, and where in a long run am I. Every choice below serves one of those.

## Two axes

The web is a far more expressive canvas than a terminal, so the view uses its dimensions to say where the reader is.

- **Vertical is position within a turn.** Top is the earliest content the model was sent: the system prompt, the tools, the first message. Bottom is the most recent: the last message, then the response.
- **Horizontal is the turn.** Left is the earlier turn, right the later. Two consecutive turns are shown side by side, aligned block by block like a side-by-side diff: unchanged blocks level, changed blocks marked, blocks only the later turn has against an empty slot on the left. The response on the left reappears on the right as history, level with itself. Runs of unchanged blocks fold into one row.
- **Moving between turns is one motion.** The right column's turn slides to the left slot and the next turn fades in on the right. Follow mode's pair is the newest turn and the one before it.

The request the model receives each turn is a whole document and the run is a sequence of versions of it. The diff is the honest view of that, and it answers the first two questions at once: what is new on the right is what just happened, and what the harness changed between turns is the only other thing marked.

## Principles

- **Color means category and nothing else.** The six category colors are the only hues the app adds to its theme; the chrome is the theme's own grays. A hue on screen is always a category.
- **Two voices.** What the app says is set in a sans. What was on the wire, every byte of content, is set in a monospace face, verbatim. The reader never wonders which is which.
- **Print what varies.** An exchange line prints the facts that differ between exchanges and nothing that repeats. A block line names the block usefully, with a preview of its content, not its category's name.
- **Hierarchy by weight and indent, never boxes.** No cards, no borders around blocks, no shadows. An exchange boundary is its line and a hairline.
- **One bold element.** The category gutter: a bar in the category's color at the left edge of every block row. Scrolling fast, the gutter alone shows the rhythm of a run. The filter bar is its legend. This is the original cc-dump's gutter, carried to the web.

## Themes

The themes are Textual's, as `@promptctl/rich-js` ships them (`themes/registry`): textual-dark, textual-light, nord, gruvbox, the catppuccins, dracula, tokyo-night, the solarizeds, the rose-pines, flexoki, monokai, atom-one and the rest. Every color on screen is a variable of the chosen theme, set once on the document root. The six category colors are derived from the theme as the original cc-dump derived its gutter and chip colors (`~/code/cc-dump/docs/THEME_COLOR_SYSTEM.md`), and placed as it placed them, in HSL, so that on textual-dark they are the colors the original showed: hues seeded in the widest gap the theme's own primary, secondary and accent hues leave, spread from the seed at the golden angle, and assigned in the original's order (tools, system, metadata, user, assistant, thinking), so an eye trained on it carries over; lightness in the theme's range. The contrast floors are then held by rich-js's contrast helper, which slides lightness and keeps the hue, in place of the original's per-hue correction loops. Adding a theme to rich-js adds it here with no change. With no choice made, the dark or light Textual theme follows the OS.

The app uses Textual's variable system whole, not a handful of its colors (https://textual.textualize.io/guide/design/). A theme is up to eleven base colors (primary, secondary, accent, foreground, background, surface, panel, success, warning, error, boost) and `dark`; from them Textual generates every variable, and rich-js's palette generates the same set. All of them are on the root under Textual's names, and each part of the app uses the variable Textual made for that purpose rather than a color of its own:

- **Shades:** `-lighten-1..3` and `-darken-1..3` of every base color.
- **Text:** `foreground` is legible on `background`, `surface` and `panel`; `foreground-muted` for what matters less, `foreground-disabled` for what cannot be used. `text-primary`, `text-secondary`, `text-accent`, `text-warning`, `text-error`, `text-success` are the base colors tinted to stay legible on those three grounds and on their own muted color. `text`, `text-muted`, `text-disabled` are black or white, whichever reads on the ground, for a ground that cannot be known ahead.
- **Muted:** `primary-muted`, `secondary-muted`, `accent-muted`, `warning-muted`, `error-muted`, `success-muted`: the base color blended into `background` at 70%; its `text-` color is legible on it.
- **Component variables:** border, block cursor and hover, input (cursor, selection), scrollbar, links, buttons, footer: the app's hairlines, hovers, selection, scrollbars, links and buttons are these, so a theme that overrides one in its `variables` changes it here as it does in Textual.

The category colors are app-specific variables in the same sense as Textual's own (`get_theme_variable_defaults`): derived from the base colors, held to the same legibility on the three grounds and on their chips.

## Type

IBM Plex Sans for the app's voice; IBM Plex Mono for the wire. One superfamily, two clearly different voices that share a skeleton. Content wraps at about 110 characters whatever the window's width.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ cc-dump  ● connected  1 in flight  last 4s ago     Recording ▾  Launch  Theme │
│ ▮ user  ▮ assistant  ▮ tools  ▮ system  ▮ metadata  ▮ thinking   search… 3/41 │
│ ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ▣  ·  ·     turn strip     │
├────────────────────────────────────┬────────────────────────────────────┬──┬──┤
│ 11  14:03:19  opus-5-5  2.1s  200  │ 12  14:03:22  opus-5-5  3.4s  200  │▒▒│  │
│     in 46.1k  cache 44k  out 390   │     in 48.2k  cache 46k  out 812   │▒▒│  │
│ ▌▸ HTTP request              929   │ ▌▸ HTTP request              929   │░░│  │
│ ▌▸ parameters              12.5k   │ ▌▸ parameters              12.5k   │░░│  │
│ ▌▸ tool definitions  63     183k   │ ▌▸ tool definitions  63     183k   │▒▒│  │
│   41 blocks unchanged              │   41 blocks unchanged              │░░│  │
│ ▌▾ text  proxy ok               8  │ ▌▾ text  proxy ok               8  │░░│  │
│                                    │ ▌▾ tool_result                569  │▒▒│  │
│                                    │ ▌  <system-reminder> …             │  │  │
│                                    │ ▌▾ text  Reading the…          210  │  │  │
│                                       ● Following                       │  │  │
└────────────────────────────────────┴────────────────────────────────────┴──┴──┘
                                                                 minimap ─┘  └─ panels
```

Left-aligned throughout. The exchange line's facts sit in aligned columns, not joined by punctuation. The minimap is the vertical navigator, the turn strip the horizontal one. The info and logs panels (F8, F9) open at the right.

## Not decided here

The exact block preview for each block type, the fold's context size, and the minimap's marks for changes are the implementing tickets' to settle against real recordings.
