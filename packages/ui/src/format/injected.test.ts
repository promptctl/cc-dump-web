import { describe, expect, it } from "vitest";
import { split, type Piece } from "./injected.ts";

// Texts shaped as Claude Code sends them, with text of their own.
const reminder = (inner: string) => `<system-reminder>\n${inner}\n</system-reminder>`;
const instructions = (path: string, description: string, text: string) => `Contents of ${path} (${description}):\n\n${text}`;
const global = instructions("/home/ann/.claude/CLAUDE.md", "user's private global instructions for all projects", "# Style\nBe brief.");
const project = instructions("/work/app/CLAUDE.md", "project instructions, checked into the codebase", "## Build\nRun make.");
const memory = instructions("/home/ann/.claude/projects/app/memory/MEMORY.md", "user's auto-memory, persists across conversations", "- Likes tea.");
const preamble = "Codebase and user instructions are shown below.";
const withInstructions = reminder(`${preamble}\n\n${global}\n\n${project}`);

// A message's text as a person typed it, and as the harness sent it in a system-role message.
const typed = (text: string) => split(text, "said");
const sent = (text: string) => split(text, "harness");
const kinds = (pieces: Piece[]) => pieces.map((piece) => piece.kind);

describe("split", () => {
  it("gives a reminder holding two CLAUDE.md files as the reminder, then each file by its path", () => {
    expect(typed(withInstructions)).toEqual([
      { kind: "reminder", text: `<system-reminder>\n${preamble}\n\n` },
      { kind: "claude_md", path: "/home/ann/.claude/CLAUDE.md", text: `${global}\n\n` },
      { kind: "claude_md", path: "/work/app/CLAUDE.md", text: `${project}\n</system-reminder>` },
    ]);
  });

  it("gives the typed prompt alone, after the reminders that came with it", () => {
    const context = reminder("As you answer the user's questions, you can use the following context:\n# userEmail\nann@example.com");
    expect(typed(`${context}\n`)).toEqual([{ kind: "reminder", text: `${context}\n` }]);
    expect(typed("Say hello.")).toEqual([{ kind: "said", text: "Say hello." }]);
    expect(typed(`${context}\n\nSay hello.`)).toEqual([
      { kind: "reminder", text: `${context}\n\n` },
      { kind: "said", text: "Say hello." },
    ]);
    expect(typed(`Say hello.\n\n${context}`)).toEqual([
      { kind: "said", text: "Say hello." },
      { kind: "reminder", text: `\n\n${context}` },
    ]);
  });

  it("gives a system-role message's hook output, which names its hook, each to the next opening or the end", () => {
    const text = "SessionStart hook additional context: Be explanatory.\n\nUserPromptSubmit hook additional context: Load the craft skill.";
    expect(sent(text)).toEqual([
      { kind: "hook", name: "SessionStart", text: "SessionStart hook additional context: Be explanatory.\n\n" },
      { kind: "hook", name: "UserPromptSubmit", text: "UserPromptSubmit hook additional context: Load the craft skill." },
    ]);
  });

  it("keeps a line that looks like hook output as what a person said", () => {
    const line = "PreToolUse hook additional context: x";
    expect(typed(line)).toEqual([{ kind: "said", text: line }]);
    expect(typed(`Look:\n${line}\n\nWhy?`)).toEqual([{ kind: "said", text: `Look:\n${line}\n\nWhy?` }]);
  });

  it("names a tag whose content opens with a hook's line for that hook, whole, in both modes", () => {
    const wrapped = reminder("PostToolUse:Read hook additional context: Mind the size.\n\n# Heading\nContents of /work/CLAUDE.md (x):\nOther hook additional context: later");
    const tagged = "<user-prompt-submit-hook>\n  UserPromptSubmit hook additional context: Load it.\n</user-prompt-submit-hook>";
    for (const split of [typed, sent]) {
      expect(split(wrapped)).toEqual([{ kind: "hook", name: "PostToolUse:Read", text: wrapped }]);
      expect(split(`${wrapped}\n\nSay hello.`)).toEqual([
        { kind: "hook", name: "PostToolUse:Read", text: `${wrapped}\n\n` },
        split === typed ? { kind: "said", text: "Say hello." } : { kind: "reminder", text: "Say hello." },
      ]);
      expect(split(tagged)).toEqual([{ kind: "hook", name: "UserPromptSubmit", text: tagged }]);
    }
  });

  it("ends a tag only at a closing tag that starts a line, so a mention of one inside a file's text does not end the reminder", () => {
    const mentions = instructions("/work/app/CLAUDE.md", "project instructions", "Wrap it in `</system-reminder>` and `<system-reminder>`, or say </system-reminder> inline.");
    const inside = reminder(`${preamble}\n\n${mentions}`);
    for (const split of [typed, sent]) {
      expect(split(`${inside}\n\nSay hello.`).map(({ kind }) => kind)).toEqual(["reminder", "claude_md", split === typed ? "said" : "reminder"]);
      expect(split(inside)[1]).toEqual({ kind: "claude_md", path: "/work/app/CLAUDE.md", text: `${mentions}\n</system-reminder>` });
    }
    // A tag that does not start its line opens nothing.
    expect(typed("Wrote <system-reminder>\nx\n</system-reminder> here.")).toEqual([{ kind: "said", text: "Wrote <system-reminder>\nx\n</system-reminder> here." }]);
  });

  it("leaves a hook's line in the middle of a reminder in the one reminder", () => {
    const middle = reminder("Context for this turn.\n\nPreToolUse hook additional context: later");
    for (const split of [typed, sent]) expect(split(middle)).toEqual([{ kind: "reminder", text: middle }]);
  });

  it("opens no section or hook inside a tag: a heading in a reminder's CLAUDE.md stays in the CLAUDE.md", () => {
    const operations = instructions("/work/app/CLAUDE.md", "project instructions", "# OPERATIONS\nWork well.\n\nSessionStart hook additional context: quoted");
    const inside = reminder(`${preamble}\n\n${operations}`);
    for (const pieces of [typed(inside), sent(inside)]) {
      expect(pieces).toEqual([
        { kind: "reminder", text: `<system-reminder>\n${preamble}\n\n` },
        { kind: "claude_md", path: "/work/app/CLAUDE.md", text: `${operations}\n</system-reminder>` },
      ]);
    }
    const hooked = "<user-prompt-submit-hook>\n# Tip\nBe brief.\n</user-prompt-submit-hook>";
    expect(sent(`${hooked}\n\n# Environment\ncwd: /work`)).toEqual([
      { kind: "hook", name: "UserPromptSubmit", text: `${hooked}\n\n` },
      { kind: "section", title: "Environment", text: "# Environment\ncwd: /work" },
    ]);
  });

  it("opens no section or hook inside a fenced code block, whichever fence opens it, and the text after the fence closes does", () => {
    const backticks = "# Setup\nRun:\n```sh\n# install deps\nnpm i\nSessionStart hook additional context: not a hook\n```\nDone.\n\n";
    const tildes = "# Setup\n~~~\n# install deps\n~~~\n\n";
    const unclosed = "# Setup\n```\n# install deps\nstill code";
    const mismatched = "# Setup\n```\n~~~\n# install deps\n```\n\n";
    expect(sent(`${backticks}# Next\nMore.`)).toEqual([
      { kind: "section", title: "Setup", text: backticks },
      { kind: "section", title: "Next", text: "# Next\nMore." },
    ]);
    expect(sent(`${tildes}# Next\nMore.`)).toEqual([
      { kind: "section", title: "Setup", text: tildes },
      { kind: "section", title: "Next", text: "# Next\nMore." },
    ]);
    expect(sent(unclosed)).toEqual([{ kind: "section", title: "Setup", text: unclosed }]);
    expect(sent(`${mismatched}# Next`)).toEqual([
      { kind: "section", title: "Setup", text: mismatched },
      { kind: "section", title: "Next", text: "# Next" },
    ]);
  });

  it("does not let a fence left open in a CLAUDE.md hide the next file's contents", () => {
    const first = instructions("/work/app/CLAUDE.md", "project instructions", "```\nnever closed");
    expect(typed(reminder(`${first}\n\n${global}`))).toEqual([
      { kind: "reminder", text: "<system-reminder>\n" },
      { kind: "claude_md", path: "/work/app/CLAUDE.md", text: `${first}\n\n` },
      { kind: "claude_md", path: "/home/ann/.claude/CLAUDE.md", text: `${global}\n</system-reminder>` },
    ]);
  });

  it("gives a user-prompt-submit-hook tag as that hook's output", () => {
    const tagged = "<user-prompt-submit-hook>\nRemember the tests.\n</user-prompt-submit-hook>";
    expect(typed(`${tagged}\n\nFix it.`)).toEqual([
      { kind: "hook", name: "UserPromptSubmit", text: `${tagged}\n\n` },
      { kind: "said", text: "Fix it." },
    ]);
  });

  it("does not take another file's contents for a CLAUDE.md's, and ends the CLAUDE.md before it", () => {
    expect(typed(reminder(`${global}\n\n${memory}`))).toEqual([
      { kind: "reminder", text: "<system-reminder>\n" },
      { kind: "claude_md", path: "/home/ann/.claude/CLAUDE.md", text: `${global}\n\n` },
      { kind: "reminder", text: `${memory}\n</system-reminder>` },
    ]);
  });

  it("leaves a text with nothing injected as one said piece, and an unclosed reminder tag as said text", () => {
    for (const text of ["", "  \n", "Plain words.", "A line:\nContents of nothing", "<system-reminder>\nnever closed", "</system-reminder> closed, never opened", `Quoted: ${project}`]) {
      expect(typed(text)).toEqual([{ kind: "said", text }]);
    }
  });

  it("puts every character of a text in exactly one piece, in order", () => {
    const texts = [
      withInstructions,
      `${withInstructions}\n${reminder("Second.")}\nSay hello.`,
      `Before.\n${reminder(`${memory}\n\nSessionStart hook additional context: x\n\n${global}`)}\n\n<user-prompt-submit-hook>y</user-prompt-submit-hook>\nAfter.`,
      `\n\n${reminder("Padded.")}  \n\n`,
      reminder(""),
      `${global}\n\nUserPromptSubmit hook additional context: z`,
      `# A\n\`\`\`\n# B\nSessionStart hook additional context: q\n\`\`\`\n${reminder(`# C\n${global}`)}\n~~~\n# D`,
      "```\n# never closed\n",
      `Before.\n\n${reminder("SessionStart hook additional context: x\n# H\n```\n")}\n  ${reminder(`${preamble}\nPreToolUse hook additional context: y`)}\nAfter.`,
    ];
    for (const text of texts) {
      expect(typed(text).map((piece) => piece.text).join("")).toBe(text);
      expect(sent(text).map((piece) => piece.text).join("")).toBe(text);
    }
    expect(kinds(typed(texts[1]!))).toEqual(["reminder", "claude_md", "claude_md", "reminder", "said"]);
  });

  it("gives a system-role message's titled sections as pieces of their own, each ending at the next, and a deeper heading inside its piece", () => {
    const hookOutput = "SessionStart hook additional context: Be explanatory.\n\n## Insights\nShare one.\n\n";
    const environment = "# Environment\nWorking directory: /work\n\n";
    const servers = "# MCP Server Instructions\n\n## docs\nUse it for docs.\n\n## search\nUse it to search.\n\n";
    const second = "UserPromptSubmit hook additional context: Load the craft skill.";
    expect(sent(hookOutput + environment + servers + second)).toEqual([
      { kind: "hook", name: "SessionStart", text: hookOutput },
      { kind: "section", title: "Environment", text: environment },
      { kind: "section", title: "MCP Server Instructions", text: servers },
      { kind: "hook", name: "UserPromptSubmit", text: second },
    ]);
  });

  it("takes what a system-role message holds before any opening as the harness's, and a person's headings as what they said", () => {
    expect(sent("Context left: 80%.")).toEqual([{ kind: "reminder", text: "Context left: 80%." }]);
    expect(sent("Context left: 80%.\n\n# Environment\ncwd: /work")).toEqual([
      { kind: "reminder", text: "Context left: 80%.\n\n" },
      { kind: "section", title: "Environment", text: "# Environment\ncwd: /work" },
    ]);
    const heading = "# Heading\nSome words.\n\n## Deeper\nMore.";
    expect(typed(heading)).toEqual([{ kind: "said", text: heading }]);
    expect(typed(`Before.\n\n${heading}`)).toEqual([{ kind: "said", text: `Before.\n\n${heading}` }]);
  });
});
