import { describe as describeError } from "@cc-dump/log/describe";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { agentBaseUrl, recordingStart } from "@cc-dump/proxy/format";
import { DependencyFailed } from "@cc-dump/log/failure";
import { send } from "@cc-dump/log/testing";
import { parseFailure } from "@cc-dump/log/wire";
import { parseLauncher, parseLaunched } from "./format.ts";
import { app } from "./testing.ts";
import { TmuxRefused } from "./tmux.ts";

describe("GET /launch", () => {
  it("starts from the default settings and lists the sessions", async () => {
    const { url, work } = await app();
    const res = await fetch(`${url}/launch`);
    expect(res.status).toBe(200);
    expect(await work()).toMatchObject({ event: "launch_settings", outcome: "ok", file_keys: null });
    expect(await work()).toMatchObject({ event: "tmux_sessions", outcome: "ok", sessions: 2 });
    expect(parseLauncher(await res.text())).toEqual({ settings: { session: null, command: "claude" }, sessions: ["work", "play"] });
  });

  it("refuses a launcher whose settings it cannot take, naming them once", () => {
    const refused = (() => {
      try {
        return parseLauncher(JSON.stringify({ settings: { session: null, command: "" }, sessions: ["work"] }));
      } catch (error) {
        return describeError(error);
      }
    })();
    expect(refused).toBe('launcher: settings: command: "" is blank or is not one line');
  });

  it("fails naming the settings file it cannot take", async () => {
    const { url, settingsPath, next } = await app();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, '{"command":""}');
    const res = await fetch(`${url}/launch`);
    expect(res.status).toBe(500);
    expect(parseFailure(await res.text())).toEqual({ error: `launch settings in ${settingsPath}: command: "" is blank or is not one line` });
    expect(await next()).toMatchObject({ event: "request", status: 500, outcome: "error" });
  });

  it("answers tmux's refusal in tmux's words", async () => {
    const { url, work } = await app({ tmux: { sessions: () => Promise.reject(new TmuxRefused("no server running on /tmp/tmux-501/default")) } });
    const res = await fetch(`${url}/launch`);
    expect(res.status).toBe(502);
    await work();
    expect(await work()).toMatchObject({ event: "tmux_sessions", outcome: "error", error: expect.stringContaining("no server running") });
    expect(parseFailure(await res.text())).toEqual({ error: "no server running on /tmp/tmux-501/default" });
  });
});

describe("POST /launch", () => {
  it("opens the agent's window pointed at the proxy by a path of its own, runs the command as written, stores the settings asked for, and answers the recording the agent will be", async () => {
    const { url, opened, settingsPath, launch, work } = await app();
    const res = await launch({ session: "work", command: "claude --dangerously-skip-permissions" });
    expect(res.status).toBe(200);
    expect(await work()).toMatchObject({ event: "proxy_info", outcome: "ok", base_url: "http://127.0.0.1:3344" });
    expect(await work()).toMatchObject({ event: "proxy_recording", outcome: "ok", recording: expect.any(String) });
    expect(await work()).toMatchObject({
      event: "launch",
      outcome: "ok",
      session: "work",
      command: "claude --dangerously-skip-permissions",
      base_url: "http://127.0.0.1:3344",
      recording: expect.any(String),
      settings_path: settingsPath,
      start_time: 1794801953,
      session_id: "$2",
      window_id: "@7",
      pane_id: "%9",
    });
    const launched = parseLaunched(await res.text());
    expect(launched).toEqual({ session: "work", start_time: 1794801953, session_id: "$2", window_id: "@7", pane_id: "%9", recording: expect.any(String) });
    expect(recordingStart(launched.recording)).toBeInstanceOf(Date);
    expect(opened).toEqual([
      { session: "work", command: "claude --dangerously-skip-permissions", cwd: "/work/project", env: { ANTHROPIC_BASE_URL: agentBaseUrl("http://127.0.0.1:3344", launched.recording) } },
    ]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ session: "work", command: "claude --dangerously-skip-permissions" });
    const launcher = parseLauncher(await (await fetch(`${url}/launch`)).text());
    expect(launcher.settings).toEqual({ session: "work", command: "claude --dangerously-skip-permissions" });
    expect(await work()).toMatchObject({ event: "launch_settings", file_keys: ["session", "command"] });
  });

  it.each([
    [{ session: "work", command: "" }, 'launch: command: "" is blank or is not one line'],
    [{ session: "work", command: "   " }, 'launch: command: "   " is blank or is not one line'],
    [{ session: "work", command: "claude\nrm -rf ~" }, "is blank or is not one line"],
    [{ session: "work", command: "claude\0" }, 'launch: command: "claude\\u0000" is blank or is not one line'],
    [{ command: "claude" }, "launch: session: is missing"],
    ["claude", "launch: is not an object"],
  ])("refuses %j, saying why, and neither launches nor stores it", async (body, reason) => {
    const { opened, settingsPath, launch, next } = await app();
    const res = await launch(body);
    expect(res.status).toBe(400);
    expect(parseFailure(await res.text()).error).toContain(reason);
    expect(await next()).toMatchObject({ event: "request", status: 400, outcome: "error", error: expect.stringContaining(reason) });
    expect(opened).toEqual([]);
    expect(() => readFileSync(settingsPath)).toThrow("ENOENT");
  });

  it("answers tmux's refusal in tmux's words", async () => {
    const { launch } = await app({ tmux: { newWindow: () => Promise.reject(new TmuxRefused("can't find session: gone")) } });
    const res = await launch({ session: "gone", command: "claude" });
    expect(res.status).toBe(502);
    expect(parseFailure(await res.text())).toEqual({ error: "can't find session: gone" });
  });

  it("does not launch an agent the proxy cannot be found for, and keeps what was asked for the next try", async () => {
    const { opened, settingsPath, launch, next, work } = await app({ proxyInfo: () => Promise.reject(new DependencyFailed("The proxy did not say where agents reach it: GET http://127.0.0.1:3347/info: fetch failed")) });
    const res = await launch({ session: "work", command: "claude" });
    expect(res.status).toBe(502);
    expect(await work()).toMatchObject({ event: "proxy_info", outcome: "error", error: expect.stringContaining("fetch failed") });
    expect(await next()).toMatchObject({ event: "request", status: 502, outcome: "error", error: expect.stringContaining("did not say where agents reach it") });
    expect(parseFailure(await res.text())).toEqual({ error: "The proxy did not say where agents reach it: GET http://127.0.0.1:3347/info: fetch failed" });
    expect(opened).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ session: "work", command: "claude" });
  });

  it("launches the agent into the recording the proxy made, named by the proxy and not by the app", async () => {
    const proxyRecording = async () => ({ name: "20200102T030405.006Z.jsonl" });
    const { opened, launch } = await app({ proxyRecording });
    const launched = parseLaunched(await (await launch({ session: "work", command: "claude" })).text());
    expect(launched.recording).toBe("20200102T030405.006Z.jsonl");
    expect(opened.map(({ env }) => env)).toEqual([{ ANTHROPIC_BASE_URL: "http://127.0.0.1:3344/agent/20200102T030405.006Z" }]);
  });

  it("does not launch an agent the proxy refused a recording, and keeps what was asked for the next try", async () => {
    const { opened, settingsPath, launch, next, work } = await app({ proxyRecording: () => Promise.reject(new DependencyFailed("The proxy did not make a recording for the agent: POST http://127.0.0.1:3347/recordings: 500 Internal Server Error")) });
    const res = await launch({ session: "work", command: "claude" });
    expect(res.status).toBe(502);
    await work();
    expect(await work()).toMatchObject({ event: "proxy_recording", outcome: "error", error: expect.stringContaining("500 Internal Server Error") });
    expect(await next()).toMatchObject({ event: "request", status: 502, outcome: "error", error: expect.stringContaining("did not make a recording") });
    expect(parseFailure(await res.text())).toEqual({ error: "The proxy did not make a recording for the agent: POST http://127.0.0.1:3347/recordings: 500 Internal Server Error" });
    expect(opened).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ session: "work", command: "claude" });
  });

  it("fails the request, on its event, when the app server fails", async () => {
    const { next, launch } = await app({ tmux: { newWindow: () => Promise.reject(new Error("tmux exploded")) } });
    const res = await launch({ session: "work", command: "claude" });
    expect(res.status).toBe(500);
    expect(parseFailure(await res.text())).toEqual({ error: "tmux exploded" });
    expect(await next()).toMatchObject({ event: "request", method: "POST", url: "/launch", outcome: "error", error: expect.stringContaining("tmux exploded") });
  });
});

describe("routes", () => {
  it("refuses a page from another site, launching nothing, on the request's event", async () => {
    const { url, opened, next } = await app();
    for (const origin of ["https://example.com", "http://127.0.0.1.example.com:3346", "null"]) {
      const res = await fetch(`${url}/launch`, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: JSON.stringify({ session: "work", command: "claude" }) });
      expect(res.status).toBe(403);
      expect(parseFailure(await res.text())).toEqual({ error: `A page at ${origin} is not one this machine serves` });
      expect(await next()).toMatchObject({ event: "request", status: 403, outcome: "error" });
    }
    expect(opened).toEqual([]);
  });

  it.each(["http://127.0.0.1:3346", "http://localhost:3346", "http://[::1]:3346"])("answers a page served from this machine, at %s", async (origin) => {
    const { opened, launch } = await app();
    const res = await launch({ session: "work", command: "claude" }, { origin });
    expect(res.status).toBe(200);
    expect(opened).toHaveLength(1);
  });

  it("refuses a request for a Host that is not the part's own address, and a path nothing serves, as Failures", async () => {
    const { port, next } = await app();
    const rebound = await send(port, { path: "/launch", headers: { host: "evil.example" } });
    expect(rebound.statusCode).toBe(403);
    expect(parseFailure((await buffer(rebound)).toString())).toEqual({ error: "Host evil.example is not an address this part is served at" });
    expect(await next()).toMatchObject({ event: "request", status: 403, outcome: "error" });
    const missing = await send(port, { path: "/elsewhere" });
    expect([missing.statusCode, parseFailure((await buffer(missing)).toString())]).toEqual([404, { error: "Nothing is served at /elsewhere" }]);
  });

  it("answers the browser's preflight of a JSON POST", async () => {
    const { url } = await app();
    const res = await fetch(`${url}/launch`, { method: "OPTIONS" });
    expect([res.status, res.headers.get("access-control-allow-methods"), res.headers.get("access-control-allow-headers")]).toEqual([204, "GET, POST", "content-type"]);
  });

  it("serves its log at /logs to the UI's page, and refuses it to a page from another site", async () => {
    const { url } = await app();
    const res = await fetch(`${url}/logs`, { headers: { origin: "http://127.0.0.1:3346" } });
    expect([res.status, res.headers.get("access-control-allow-origin"), await res.text()]).toEqual([200, "http://127.0.0.1:3346", "the app server's log"]);
    expect((await fetch(`${url}/logs`, { headers: { origin: "https://example.com" } })).status).toBe(403);
  });
});

describe("the launch's answer", () => {
  const launched = (fields: Record<string, unknown>) =>
    JSON.stringify({ session: "work", start_time: 1794801953, session_id: "$1", window_id: "@12", pane_id: "%30", recording: "r.jsonl", ...fields });

  it("addresses the window by its server's start time, its session's id and its own, beside its pane's", () => {
    expect(parseLaunched(launched({}))).toMatchObject({ start_time: 1794801953, session_id: "$1", window_id: "@12", pane_id: "%30" });
  });

  it.each([
    [{ window_id: "12" }, /not a tmux window id: "12"/],
    [{ pane_id: "@2" }, /not a tmux pane id: "@2"/],
    [{ session_id: "@1" }, /not a tmux session id: "@1"/],
    [{ window_id: "@1x" }, /not a tmux window id/],
    [{ window_id: "@03" }, /not a tmux window id/],
    [{ session_id: "$9007199254740993" }, /not a tmux session id/],
    [{ start_time: -1 }, /not a tmux server's start time: "-1"/],
    [{ start_time: 1.5 }, /start_time: is not an integer/],
  ])("is refused with %j, which tmux would not write", (fields, error) => {
    expect(() => parseLaunched(launched(fields))).toThrow(error);
  });
});
