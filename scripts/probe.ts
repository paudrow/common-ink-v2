// Drive the app in headless Chrome with real keys and print what it says, as JSON (docs/TESTING.md):
// one command to check a change instead of clicking around.
//
//   npm run probe -- --scenario lists --open "Lists tour" --keys "/Basil<CR>>>" --wait idle --dump cursor --screenshot out.png
//   npm run probe -- --url https://pr-26-common-ink-v2.example.workers.dev --scenario tasks --check overlaps
//
// Without --url it starts the Worker itself, on a fresh workspace, rebuilding the app first if the code
// changed. With --url it drives that app (npm run dev, or a Preview); --scenario resets its workspace.
// Setup options apply first; the steps run in the order given. Each step that answers prints a line
// of JSON, and the last line says whether the page logged any errors. It exits 1 if a step failed or
// the page logged an error (unless --allow-errors).
//
// Setup: --url, --scenario, --device phone|tablet|laptop, --viewport 1200x800, --dark, --now <time>,
//        --permissions allow|deny|ask, --net replay|live, --offline, --allow-errors
// Steps: --open <note>, --keys <keys>, --type <text>, --click <selector>, --command <title>, --cursor <line[:col]>,
//        --wait idle|<ms>|<selector>, --dump state|<field>, --check overlaps|lineShift|layoutFill|all,
//        --probe-embeds, --eval <js>, --screenshot <file>, --reload, --set-offline on|off
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Page } from "playwright-core";
import { ensureBuilt, isExpectedConsoleError, launchChrome, startWorker, type LocalWorker } from "../test/browser/launch.ts";
import { parseKeys, playwrightKey } from "../web/src/dev/key-notation.ts";
import { PRESETS, type Preset } from "../web/src/device.ts";

const STEPS = ["open", "keys", "type", "click", "command", "cursor", "wait", "dump", "check", "probe-embeds", "eval", "screenshot", "reload", "set-offline"] as const;
const { values, tokens } = parseArgs({
  tokens: true,
  allowPositionals: false,
  options: {
    url: { type: "string" },
    scenario: { type: "string" },
    viewport: { type: "string" },
    device: { type: "string" },
    dark: { type: "boolean" },
    now: { type: "string" },
    permissions: { type: "string" },
    net: { type: "string" },
    offline: { type: "boolean" },
    "allow-errors": { type: "boolean" },
    ...Object.fromEntries(STEPS.map((s) => [s, { type: s === "probe-embeds" || s === "reload" ? "boolean" : "string", multiple: true }])),
  },
});

const out = (step: string, value: unknown) => console.log(JSON.stringify({ step, value }));
// A device stands in for a phone, a tablet or a laptop: its size, touch, and the `device` lever for the rest.
const device = values.device as Preset | undefined;
if (device && !(device in PRESETS)) throw new Error(`--device is phone, tablet or laptop, not ${device}`);
const [width, height] = (values.viewport ?? (device ? `${PRESETS[device].width}x${PRESETS[device].height}` : "1200x800")).split("x").map(Number);

let local: LocalWorker | null = null;
if (!values.url) ensureBuilt();
const browser = await launchChrome();
let failed = false;
const errors: string[] = [];
try {
  local = values.url ? null : await startWorker();
  const base = (values.url ?? local!.base).replace(/\/$/, "");
  const touch = !!device && PRESETS[device].touch;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: values.dark ? "dark" : "light", hasTouch: touch, isMobile: touch });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !isExpectedConsoleError(m.text(), m.location().url) && errors.push(`${m.text()} ${m.location().url}`));
  if (values.scenario) {
    const res = await context.request.post(`${base}/api/levers/reset`, { data: { scenario: values.scenario } });
    if (!res.ok()) throw new Error(`Couldn't reset to ${values.scenario}: ${res.status()} ${await res.text()} (has this app test levers?)`);
  }
  const levers = new URLSearchParams();
  for (const k of ["now", "permissions", "net", "device"] as const) if (values[k]) levers.set(k, values[k]!);
  if (values.offline) levers.set("offline", "1");
  await page.goto(`${base}/${levers.size ? `?${levers}` : ""}`);
  await ready(page);
  for (const t of tokens) {
    if (t.kind !== "option" || !(STEPS as readonly string[]).includes(t.name)) continue;
    await step(page, t.name, t.value ?? "");
  }
} catch (err) {
  failed = true;
  out("error", (err as Error).message);
} finally {
  await browser.close();
  await local?.stop();
}
console.log(JSON.stringify({ ok: !failed && (values["allow-errors"] || !errors.length), errors }));
process.exit(failed || (!values["allow-errors"] && errors.length) ? 1 : 0);

async function ready(page: Page) {
  await page.waitForFunction(() => "__commonInk" in window, null, { timeout: 15_000 }).catch(() => {
    throw new Error("This page has no test levers: is it production, or a Worker without LEVERS?");
  });
}

async function step(page: Page, name: string, arg: string) {
  const inspect = <T>(fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window as unknown as Record<string, Record<string, (...a: unknown[]) => T>>).__commonInk[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<T>;
  switch (name) {
    case "open":
      return inspect("open", arg);
    case "keys":
      for (const k of parseKeys(arg, process.platform === "darwin")) await page.keyboard.press(playwrightKey(k));
      return;
    case "type":
      return page.keyboard.insertText(arg);
    case "click":
      return page.click(arg);
    case "command":
      return inspect("command", arg);
    case "cursor": {
      const [line, column] = arg.split(":").map(Number);
      return inspect("cursor", line, column || 1);
    }
    case "wait":
      if (arg === "idle") return inspect("idle");
      if (/^\d+$/.test(arg)) return page.waitForTimeout(Number(arg));
      return void (await page.waitForSelector(arg));
    case "dump": {
      const state = (await inspect("state")) as Record<string, unknown>;
      return out(`dump ${arg}`, arg === "state" || !arg ? state : state[arg]);
    }
    case "check": {
      const checks = arg === "all" ? ["overlaps", "lineShift", "layoutFill"] : [arg];
      for (const c of checks) out(`check ${c}`, await page.evaluate((c) => (window as unknown as { __commonInk: { check: Record<string, () => unknown> } }).__commonInk.check[c](), c));
      return;
    }
    case "probe-embeds":
      return out("probe-embeds", await page.evaluate(() => (window as unknown as { __commonInk: { embeds: { probe(): unknown } } }).__commonInk.embeds.probe()));
    case "eval":
      return out("eval", await page.evaluate(arg));
    case "screenshot":
      writeFileSync(arg, await page.screenshot());
      return out("screenshot", arg);
    case "reload":
      await page.reload();
      return ready(page);
    case "set-offline":
      return void (await page.context().setOffline(arg === "on"));
  }
}
