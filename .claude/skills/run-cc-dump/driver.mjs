#!/usr/bin/env node
// Drives the cc-dump UI in headless Chrome: one browser session per run, commands read from stdin, one per line.
//
//   node .claude/skills/run-cc-dump/driver.mjs <<'EOF'
//   open
//   ss home
//   EOF
//
// Commands:
//   open [path]          go to path in the UI (http://127.0.0.1:3346), wait for network idle
//   ss <name>            full-window screenshot to $CC_DUMP_SHOTS/<name>.png (default /tmp/cc-dump-shots)
//   click <selector>     Playwright selector: css, text=Foo, role=button[name="Launch"], ...
//   fill <selector> | <text>   (split at the first " | ")
//   press <key>          keyboard key on the focused element (Enter, Escape, ArrowRight, Meta+f, ...)
//   wait <selector>      wait (10s) for the selector to be visible
//   text [selector]      print innerText (default body), cut at 4000 chars
//   count <selector>     print how many elements match
//   eval <js>            evaluate an expression in the page, print the JSON result
//   sleep <ms>
//   errors               print console errors and page errors seen so far
// A command's argument is the rest of its line, as written. Lines starting with # are ignored. A failing command prints ERR and the run continues; the exit code is 1 if any did.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

const base = process.env.CC_DUMP_UI ?? "http://127.0.0.1:3346";
const shots = process.env.CC_DUMP_SHOTS ?? "/tmp/cc-dump-shots";
mkdirSync(shots, { recursive: true });

// The system Google Chrome, so no browser download is needed; CC_DUMP_CHANNEL=chromium uses Playwright's own build.
const browser = await chromium.launch({ channel: process.env.CC_DUMP_CHANNEL ?? "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const commands = {
  open: async (path) => {
    await page.goto(new URL(path || "/", base).href, { waitUntil: "networkidle" });
    return page.url();
  },
  ss: async (name) => {
    const file = join(shots, `${name || `shot-${Date.now()}`}.png`);
    await page.screenshot({ path: file });
    return file;
  },
  click: async (sel) => (await page.locator(sel).first().click({ timeout: 10_000 }), "ok"),
  fill: async (arg) => {
    const at = arg.indexOf(" | ");
    if (at === -1) throw new Error("fill takes <selector> | <text>");
    await page.locator(arg.slice(0, at)).first().fill(arg.slice(at + 3), { timeout: 10_000 });
    return "ok";
  },
  press: async (key) => (await page.keyboard.press(key), "ok"),
  wait: async (sel) => (await page.locator(sel).first().waitFor({ state: "visible", timeout: 10_000 }), "ok"),
  text: async (sel) => (await page.locator(sel || "body").first().innerText({ timeout: 10_000 })).slice(0, 4000),
  count: async (sel) => String(await page.locator(sel).count()),
  eval: async (js) => JSON.stringify(await page.evaluate(js)),
  sleep: async (ms) => {
    if (!/^\d+$/.test(ms)) throw new Error(`sleep takes a whole number of milliseconds, got ${JSON.stringify(ms)}`);
    return (await page.waitForTimeout(Number(ms)), "ok");
  },
  errors: async () => (errors.length ? errors.join("\n") : "(none)"),
};

let failed = false;
for await (const raw of createInterface({ input: process.stdin })) {
  const line = raw.trimStart();
  if (!line.trim() || line.startsWith("#")) continue;
  const [name] = line.split(/\s/, 1);
  try {
    if (!Object.hasOwn(commands, name)) throw new Error(`unknown command: ${name}`);
    // The argument keeps its trailing whitespace: `fill <selector> | ` fills nothing, which clears the field.
    console.log(`> ${line}\n${await commands[name](line.slice(name.length).replace(/^\s/, ""))}`);
  } catch (error) {
    failed = true;
    console.log(`> ${line}\nERR ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
