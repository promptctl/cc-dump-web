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

const kinds = (pieces: Piece[]) => pieces.map((piece) => piece.kind);

describe("split", () => {
  it("gives a reminder holding two CLAUDE.md files as the reminder, then each file by its path", () => {
    expect(split(withInstructions)).toEqual([
      { kind: "reminder", text: `<system-reminder>\n${preamble}\n\n` },
      { kind: "claude_md", path: "/home/ann/.claude/CLAUDE.md", text: `${global}\n\n` },
      { kind: "claude_md", path: "/work/app/CLAUDE.md", text: `${project}\n</system-reminder>` },
    ]);
  });

  it("gives the typed prompt alone, after the reminders that came with it", () => {
    const context = reminder("As you answer the user's questions, you can use the following context:\n# userEmail\nann@example.com");
    expect(split(`${context}\n`)).toEqual([{ kind: "reminder", text: `${context}\n` }]);
    expect(split("Say hello.")).toEqual([{ kind: "said", text: "Say hello." }]);
    expect(split(`${context}\n\nSay hello.`)).toEqual([
      { kind: "reminder", text: `${context}\n\n` },
      { kind: "said", text: "Say hello." },
    ]);
    expect(split(`Say hello.\n\n${context}`)).toEqual([
      { kind: "said", text: "Say hello." },
      { kind: "reminder", text: `\n\n${context}` },
    ]);
  });

  it("gives hook output, which names its hook, each to the next hook or the end", () => {
    const text = "SessionStart hook additional context: Be explanatory.\n\n# Environment\ncwd: /work\n\nUserPromptSubmit hook additional context: Load the craft skill.";
    expect(split(text)).toEqual([
      { kind: "hook", name: "SessionStart", text: "SessionStart hook additional context: Be explanatory.\n\n# Environment\ncwd: /work\n\n" },
      { kind: "hook", name: "UserPromptSubmit", text: "UserPromptSubmit hook additional context: Load the craft skill." },
    ]);
    expect(split(reminder("PostToolUse:Read hook additional context: Mind the size."))).toEqual([
      { kind: "reminder", text: "<system-reminder>\n" },
      { kind: "hook", name: "PostToolUse:Read", text: "PostToolUse:Read hook additional context: Mind the size.\n</system-reminder>" },
    ]);
  });

  it("gives a user-prompt-submit-hook tag as that hook's output", () => {
    const tagged = "<user-prompt-submit-hook>\nRemember the tests.\n</user-prompt-submit-hook>";
    expect(split(`${tagged}\n\nFix it.`)).toEqual([
      { kind: "hook", name: "UserPromptSubmit", text: `${tagged}\n\n` },
      { kind: "said", text: "Fix it." },
    ]);
  });

  it("does not take another file's contents for a CLAUDE.md's, and ends the CLAUDE.md before it", () => {
    expect(split(reminder(`${global}\n\n${memory}`))).toEqual([
      { kind: "reminder", text: "<system-reminder>\n" },
      { kind: "claude_md", path: "/home/ann/.claude/CLAUDE.md", text: `${global}\n\n` },
      { kind: "reminder", text: `${memory}\n</system-reminder>` },
    ]);
  });

  it("leaves a text with nothing injected as one said piece, and an unclosed reminder tag as said text", () => {
    for (const text of ["", "  \n", "Plain words.", "A line:\nContents of nothing", "<system-reminder>\nnever closed", "</system-reminder> closed, never opened", `Quoted: ${project}`]) {
      expect(split(text)).toEqual([{ kind: "said", text }]);
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
    ];
    for (const text of texts) expect(split(text).map((piece) => piece.text).join("")).toBe(text);
    expect(kinds(split(texts[1]!))).toEqual(["reminder", "claude_md", "claude_md", "reminder", "said"]);
  });
});
