#!/usr/bin/env node
// A stand-in for api.anthropic.com, so traffic through the proxy costs nothing and needs no key.
//   node .claude/skills/run-cc-dump/fake-anthropic.mjs [port]     (default 3399)
// POST /v1/messages answers like the real API: an SSE stream when the body says "stream": true, else one JSON message.
// The reply is a thinking block and a text block that echoes the last user message. A body it cannot read a request
// from answers 400, as the API does. GET /fake-anthropic answers 200, so a client can tell this fake is what it reaches. Every other
// path answers 404.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3399);

function lastUserText(body) {
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const content = typeof user?.content === "string" ? user.content : (user?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
  return content || "(no user text)";
}

function reply(body, n) {
  const said = lastUserText(body);
  return {
    id: `msg_fake_${n}`,
    type: "message",
    role: "assistant",
    model: body.model ?? "claude-fake",
    content: [
      { type: "thinking", thinking: `The user said: ${said}`, signature: "fake-signature" },
      { type: "text", text: `Echo ${n}: ${said}` },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10 * n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 + said.length },
  };
}

function streamed(message) {
  const events = [["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } }]];
  message.content.forEach((block, index) => {
    const [empty, delta] =
      block.type === "thinking"
        ? [{ type: "thinking", thinking: "", signature: "" }, { type: "thinking_delta", thinking: block.thinking }]
        : [{ type: "text", text: "" }, { type: "text_delta", text: block.text }];
    events.push(["content_block_start", { type: "content_block_start", index, content_block: empty }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta }]);
    if (block.type === "thinking") events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

let count = 0;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    if (req.method === "GET" && new URL(req.url, "http://x").pathname.endsWith("/fake-anthropic")) return void res.writeHead(200).end("fake-anthropic");
    if (req.method !== "POST" || !new URL(req.url, "http://x").pathname.endsWith("/v1/messages")) return void res.writeHead(404).end('{"type":"error"}');
    let body, message;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
      message = reply(body, ++count);
    } catch (error) {
      console.log(`fake-anthropic: ${req.method} ${req.url} -> 400 ${error.message}`);
      return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error.message } }));
    }
    console.log(`fake-anthropic: ${req.method} ${req.url} -> ${message.id}`);
    if (!body.stream) return void res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${count}` }).end(JSON.stringify(message));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_fake_${count}` });
    // Chunks spaced out, so the UI shows a response while it streams.
    for (const chunk of streamed(message)) {
      res.write(chunk);
      await new Promise((r) => setTimeout(r, 50));
    }
    res.end();
  });
}).listen(port, "127.0.0.1", () => console.log(`fake-anthropic: listening on http://127.0.0.1:${port}`));
