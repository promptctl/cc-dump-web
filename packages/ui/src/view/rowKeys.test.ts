import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { assistant, reply, request, text, user } from "../../test/fixtures.ts";
import { categories, type Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import type { Visibility } from "../settings.ts";
import { exchanges } from "../testing.ts";
import { contentsKey } from "./contents.ts";
import { createHistory } from "./history.ts";
import { regionKey } from "./regions.ts";
import { createLayout, nestKey, pastKey } from "./rows.ts";
import { address, partKey } from "./search.ts";
import { viewVersion } from "./state.ts";

// Every category listed, each block and set in full.
const expanded = Object.fromEntries(categories.map((category) => [category, "expanded"])) as Record<Category, Visibility>;

describe("the row-key scheme", () => {
  // [LAW:one-source-of-truth] A stored view names rows by these keys under its version (state.ts `viewVersion`). A key
  // made another way is a key a view stored before does not hold, so a key of each kind is pinned here beside the
  // version: a key changed fails here, where the version is changed with it to the next scheme.
  it("is the stored view's version", () => {
    const main = { model: "m", system: [text("Be brief.")], tools: [{ name: "Read" }] };
    const hi = user(text("Hi."));
    const events = [
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [text("Hello.")]),
      ...request("t2", { ...main, messages: [hi, { role: "assistant", content: [text("Hello.")] }, user(text("More."))] }),
      ...request("aside", { ...main, messages: [hi, { role: "assistant", content: [text("Hello.")] }, user(text("Aside?"))] }),
    ];
    // A compaction, whose summary's thread is a row of its own.
    const summary = "<analysis>\nThought.\n</analysis>\n\n<summary>\n1. Said hello.\n</summary>\n";
    const compacted = [
      ...request("t1", { ...main, messages: [hi] }),
      ...reply("t1", [text("Hello.")]),
      ...request("compact", { ...main, messages: [hi, assistant(text("Hello.")), user(text("More."), text("Summarize."))] }),
      ...reply("compact", [text(summary)]),
      ...request("c1", { ...main, messages: [user(text("This session is being continued.\nSummary:\n1. Said hello.\nGo on."))] }),
    ];
    const layoutOf = (events: RecordedEvent[], step: number) => createLayout(expanded)(createHistory()(createFormatter()(exchanges(events))), step, undefined, {});
    const layout = layoutOf(events, 3);
    const block = "thread:t1/message.0/content.0";
    const keys = {
      rows: layout.every.rows.map(({ key }) => key),
      threads: layoutOf(compacted, 3)
        .every.rows.filter(({ kind }) => kind === "thread")
        .map(({ key }) => key),
      made: [pastKey(block), nestKey({ kind: "main" }), partKey(block, address.name), regionKey(partKey(block, address.name), 2), contentsKey(partKey(block, address.name))],
    };
    expect({ version: viewVersion, keys }).toEqual({
      version: 7,
      keys: {
        rows: [
          "t1",
          "t1/request/http",
          "thread:t1/request/parameters",
          "t1/response/http",
          "t1/response/stop reason",
          "t1/response/usage",
          "t1/response/fields",
          "t1/tools",
          "thread:t1/tools/tools.Read.0",
          "t1/system",
          "thread:t1/system/system.0",
          "t1/message.0",
          "thread:t1/message.0/content.0",
          "t1/reply",
          "thread:t1/message.1/content.0",
          "t1/fork",
          "aside",
          "aside/request/http",
          "aside/message.2",
          "thread:aside/message.2/content.0",
        ],
        threads: ["thread:compact/message.3/content.0/thread"],
        made: [
          "past:thread:t1/message.0/content.0",
          "nest:main",
          'thread:t1/message.0/content.0/["name"]',
          'thread:t1/message.0/content.0/["name"]/2',
          'contents:thread:t1/message.0/content.0/["name"]',
        ],
      },
    });
  });
});
