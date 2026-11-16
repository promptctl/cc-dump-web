#!/usr/bin/env node
// Plays an agent through the proxy: makes an agent recording the way the Launch button does (POST /recordings on the
// reader port), then sends a growing conversation of streaming /v1/messages requests to the proxy under that
// recording's path, one turn at a time, as Claude Code would.
//   node .claude/skills/run-cc-dump/traffic.mjs [turns]       (default 3)
// Env: CC_DUMP_READER_PORT (3347); the proxy's address is the one its `GET /info` gives agents.
// A proxy whose upstream is not mock-anthropic (a stack forwarding to the real API, recording into the user's real
// recordings) is refused before anything is sent: the mock, asked at its upstream for a path it has no endpoint for,
// names itself in its error.
const turns = Number(process.argv[2] ?? 3);
if (!Number.isInteger(turns) || turns < 1) throw new Error(`turns must be a positive integer, got ${JSON.stringify(process.argv[2])}`);
const reader = `http://127.0.0.1:${process.env.CC_DUMP_READER_PORT ?? 3347}`;

async function ok(res, what) {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res;
}

const { base_url, upstream } = await (await ok(await fetch(`${reader}/info`), `GET ${reader}/info`)).json();
// A proxy older than `upstream` in its info says nothing of where it forwards, and is refused the same way.
const probe = URL.parse("run-cc-dump-probe", upstream);
const mock =
  probe !== null &&
  (await fetch(probe, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => (await res.json()).error?.message?.startsWith("mock-anthropic UNMATCHED:") === true)
    .catch(() => false));
if (!mock) throw new Error(`the proxy at ${base_url} forwards to ${upstream}, where no mock-anthropic answers; refusing to send it traffic`);

const { name } = await (await ok(await fetch(`${reader}/recordings`, { method: "POST" }), `POST ${reader}/recordings`)).json();
const base = `${base_url}/agent/${name.slice(0, -".jsonl".length)}`;
console.log(`recording ${name}  (ANTHROPIC_BASE_URL=${base}, upstream ${upstream})`);

const system = [{ type: "text", text: "You are a fake agent driven by traffic.mjs." }];
const messages = [];
for (let turn = 1; turn <= turns; turn++) {
  messages.push({ role: "user", content: [{ type: "text", text: `Turn ${turn}: say something about step ${turn}.` }] });
  const res = await fetch(`${base}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "fake-key" },
    body: JSON.stringify({ model: "claude-fake-1", max_tokens: 1024, stream: true, system, messages }),
  });
  const text = await (await ok(res, `turn ${turn}`)).text();
  // The assistant's reply goes back into the history, as an agent's would: the text deltas joined.
  const said = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)).delta)
    .filter((delta) => delta?.type === "text_delta")
    .map((delta) => delta.text)
    .join("");
  if (!said) throw new Error(`turn ${turn}: ${res.status}, but no text_delta in the reply:\n${text.slice(0, 2000)}`);
  messages.push({ role: "assistant", content: [{ type: "text", text: said }] });
  console.log(`turn ${turn}: ${res.status} ${said}`);
}
