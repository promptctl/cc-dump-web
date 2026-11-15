#!/usr/bin/env node
// Plays an agent through the proxy: makes an agent recording the way the Launch button does (POST /recordings on the
// reader port), then sends a growing conversation of streaming /v1/messages requests to the proxy under that
// recording's path, one turn at a time, as Claude Code would.
//   node .claude/skills/run-cc-dump/traffic.mjs [turns]       (default 3)
// Env: CC_DUMP_PROXY_PORT (3344), CC_DUMP_READER_PORT (3347). Point the proxy at fake-anthropic.mjs first, or every
// turn is a real, billed API request (and fails with 401, since no key is sent).
const turns = Number(process.argv[2] ?? 3);
const proxy = `http://127.0.0.1:${process.env.CC_DUMP_PROXY_PORT ?? 3344}`;
const reader = `http://127.0.0.1:${process.env.CC_DUMP_READER_PORT ?? 3347}`;

const created = await fetch(`${reader}/recordings`, { method: "POST" });
if (!created.ok) throw new Error(`POST ${reader}/recordings: ${created.status} ${await created.text()}`);
const { name } = await created.json();
const base = `${proxy}/agent/${name.slice(0, -".jsonl".length)}`;
console.log(`recording ${name}  (ANTHROPIC_BASE_URL=${base})`);

const system = [{ type: "text", text: "You are a fake agent driven by traffic.mjs." }];
const messages = [];
for (let turn = 1; turn <= turns; turn++) {
  messages.push({ role: "user", content: [{ type: "text", text: `Turn ${turn}: say something about step ${turn}.` }] });
  const res = await fetch(`${base}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "fake-key" },
    body: JSON.stringify({ model: "claude-fake-1", max_tokens: 1024, stream: true, system, messages }),
  });
  const text = await res.text();
  // The assistant's reply goes back into the history, as an agent's would: the text deltas joined.
  const said = [...text.matchAll(/"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map(([, s]) => JSON.parse(s)).join("");
  messages.push({ role: "assistant", content: [{ type: "text", text: said || "(nothing)" }] });
  console.log(`turn ${turn}: ${res.status} ${said}`);
}
