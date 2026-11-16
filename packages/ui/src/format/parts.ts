import type { Header } from "@cc-dump/proxy/format";

// What a media source is the source of: an image the view shows as one, or a document it names.
export type Medium = "image" | "document";
export type Source = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } | { type: "file"; file_id: string };

// How a text reads (docs/design/02-design.md, "Two voices"): as Markdown, the way the model writes and reads what a
// sender wrote, or verbatim, the way a tool returned it or the proxy reports it. [LAW:one-type-per-behavior] One kind of
// text part, one rendering; the form is a value.
export type Form = "markdown" | "verbatim";

// [LAW:locality-or-seam] What a block shows, in kinds the view renders without knowing the API: a new block type, or a
// richer rendering of one, is a change to the formatter alone.
export type Part =
  | { kind: "text"; form: Form; label?: string; text: string }
  | { kind: "json"; label?: string; value: unknown }
  | { kind: "fields"; label?: string; fields: Header[] }
  | { kind: "media"; label?: string; of: Medium; source: Source }
  // A change of one text into another, shown line by line: what it removed and what it added, among the lines it kept
  // (format/diff.ts).
  | { kind: "diff"; label?: string; before: string; after: string };

// Why a value is not shown as what it was read as, set before the value as it was received.
export const doesNotFit = (reason: string): Part => ({ kind: "text", form: "verbatim", label: "does not fit", text: reason });
