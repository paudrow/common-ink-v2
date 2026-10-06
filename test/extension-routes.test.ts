import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { extensionApi, sandboxRoute } from "../worker/src/extension-routes.ts";
import { appCsp, sandboxCsp, signCodeToken, verifyCodeToken } from "../worker/src/sandbox.ts";
import { memoryStore } from "./store.ts";

const you: Author = { kind: "user", email: "you@example.com" };

function store() {
  const s = memoryStore();
  return Object.assign(s, { sandboxKey: () => s.files.secret("sandbox-key") });
}

const write = (s: ReturnType<typeof store>, path: string, text: string) => s.files.write({ path: path as FilePath, text, base: s.files.read(path as FilePath)?.revision ?? 0, author: you });

const WEATHER = JSON.stringify({ name: "Weather", permissions: { network: { hosts: ["api.weather.gov"], why: "Fetch forecasts" } } });

/** Calls to the global fetch, answered by `answer`, for the length of `run`. */
async function withFetch(answer: (url: string) => Response, run: () => Promise<void>) {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("https://cloudflare-dns.com/")) return Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
    return answer(url);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

const post = (path: string, body: unknown) => new Request(`https://app.example${path}`, { method: "POST", body: JSON.stringify(body) });

test("a code token is for one extension, is signed, and runs out", async () => {
  const token = await signCodeToken("key", "weather", 2000);
  assert.equal(await verifyCodeToken("key", token, 1000), "weather");
  assert.equal(await verifyCodeToken("key", token, 3000), null, "expired");
  assert.equal(await verifyCodeToken("other key", token, 1000), null, "forged");
  assert.equal(await verifyCodeToken("key", token.replace("weather", "history"), 1000), null, "for another extension");
});

test("the sandbox route serves shells with a policy that lets nothing out, and code only against a token", async () => {
  const s = store();
  write(s, ".common-ink/extensions/weather/extension.json", WEATHER);
  write(s, ".common-ink/extensions/weather/index.js", "export default { activate() {} };");
  write(s, "Secrets.md", "my secret");
  const assets = { fetch: async () => new Response("// shell") } as unknown as { fetch(req: Request): Promise<Response> };
  const get = (path: string) => sandboxRoute(new Request(`https://app.example${path}`), new URL(`https://app.example${path}`), assets, s);
  const host = await get("/sandbox/host");
  assert.equal(host.headers.get("Content-Security-Policy"), sandboxCsp("https://app.example", "host"));
  assert.match(host.headers.get("Content-Security-Policy")!, /connect-src 'none'/);
  assert.match(sandboxCsp("https://app.example", "webview"), /img-src data: blob: https:\/\/app\.example\/sandbox\/;/);
  assert.equal((await get("/sandbox/code/forged/index.js")).status, 404);
  const token = ((await (await extensionApi(new Request("https://app.example/api/sandbox/token?extension=weather"), new URL("https://app.example/api/sandbox/token?extension=weather"), you.email, you, s))!.json()) as { token: string }).token;
  const code = await get(`/sandbox/code/${token}/index.js`);
  assert.equal(code.status, 200);
  assert.equal(code.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await code.text(), "export default { activate() {} };");
  assert.equal((await get(`/sandbox/code/${token}/../../../Secrets.md`)).status, 404, "a token reaches only that extension's code");
  assert.equal((await get(`/sandbox/code/${token}/extension.json`)).status, 404, "and only .js files");
});

test("the brokered fetch reaches only declared hosts you've allowed, without credentials", async () => {
  const s = store();
  write(s, ".common-ink/extensions/weather/extension.json", WEATHER);
  const ask = (body: unknown) => extensionApi(post("/api/extensions/fetch", body), new URL("https://app.example/api/extensions/fetch"), you.email, you, s);
  const seen = await withFetch(
    () => new Response("sunny"),
    async () => {
      assert.deepEqual(await (await ask({ extension: "weather", url: "https://evil.example/?data=1" }))!.json(), { error: "Weather doesn't declare evil.example in its extension.json, so it can't reach it" });
      assert.deepEqual(await (await ask({ extension: "weather", url: "https://api.weather.gov/points" }))!.json(), { error: "Weather isn't allowed to reach api.weather.gov" });
      write(s, ".common-ink/users/you@example.com/settings.json", JSON.stringify({ "extensions.permissions": { weather: { "network:api.weather.gov": "allow" } } }));
      const ok = (await (await ask({ extension: "weather", url: "https://api.weather.gov/points", headers: { Cookie: "x=1" } }))!.json()) as { status: number; body: string };
      assert.deepEqual([ok.status, ok.body], [200, "sunny"]);
      write(s, ".common-ink/users/you@example.com/settings.json", JSON.stringify({ "extensions.permissions": { weather: { "network:api.weather.gov": "deny" } } }));
      assert.equal((await ask({ extension: "weather", url: "https://api.weather.gov/points", once: true }))!.status, 403, "a kept no beats once");
    },
  );
  assert.deepEqual(seen.filter((u) => !u.includes("cloudflare-dns")), ["https://api.weather.gov/points"], "nothing else went out");
});

test("installing copies an extension's files in, as changes by you; a built-in's id is refused", async () => {
  const s = store();
  const files: Record<string, string> = {
    "https://ext.example/weather/extension.json": JSON.stringify({ id: "weather", name: "Weather", main: "index.js", files: ["lib.js"] }),
    "https://ext.example/weather/index.js": 'import "./lib.js"; export default { activate() {} };',
    "https://ext.example/weather/lib.js": "export const x = 1;",
    "https://ext.example/history/extension.json": JSON.stringify({ id: "history", name: "Not history" }),
  };
  await withFetch(
    (url) => (files[url] ? new Response(files[url]) : new Response("nope", { status: 404 })),
    async () => {
      const install = (url: string) => extensionApi(post("/api/extensions/install", { url }), new URL("https://app.example/api/extensions/install"), you.email, you, s);
      assert.deepEqual(await (await install("https://ext.example/weather/"))!.json(), { id: "weather", name: "Weather", files: ["extension.json", "index.js", "lib.js", "installed.json"] });
      assert.equal(s.files.read(".common-ink/extensions/weather/lib.js" as FilePath)?.text, "export const x = 1;");
      assert.deepEqual(JSON.parse(s.files.read(".common-ink/extensions/weather/installed.json" as FilePath)!.text), { from: "https://ext.example/weather/extension.json" }, "where it came from, for the app to say");
      assert.deepEqual(s.files.recent({ path: ".common-ink/extensions/weather/index.js" as FilePath })[0].author, you);
      assert.deepEqual(await (await install("https://ext.example/history/"))!.json(), { error: '"history" is a built-in\'s id. To change a built-in, Customize it.' });
      assert.deepEqual(await (await install("http://localhost:8787/x/"))!.json(), { error: "Local names can't be fetched" });
    },
  );
});

test("installing from a URL never inherits trust left for the same id: it starts sandboxed for everyone", async () => {
  const s = store();
  write(s, ".common-ink/settings.json", `${JSON.stringify({ "extensions.trusted": ["weather", "boards"], "editor.fontSize": 15 }, null, 2)}\n`);
  write(s, ".common-ink/users/you@example.com/settings.json", `${JSON.stringify({ "extensions.trusted": ["weather"] }, null, 2)}\n`);
  write(s, ".common-ink/users/sam@example.com/settings.json", `${JSON.stringify({ "extensions.trusted": ["weather", "timers"] }, null, 2)}\n`);
  const files: Record<string, string> = {
    "https://other.example/weather/extension.json": JSON.stringify({ id: "weather", name: "Someone else's Weather" }),
    "https://other.example/weather/index.js": "export default { activate() {} };",
  };
  await withFetch(
    (url) => (files[url] ? new Response(files[url]) : new Response("nope", { status: 404 })),
    async () => {
      const res = await extensionApi(post("/api/extensions/install", { url: "https://other.example/weather/" }), new URL("https://app.example/api/extensions/install"), you.email, you, s);
      assert.equal(res!.status, 200);
    },
  );
  const trusted = (path: string) => JSON.parse(s.files.read(path as FilePath)!.text)["extensions.trusted"];
  assert.deepEqual(trusted(".common-ink/settings.json"), ["boards"]);
  assert.deepEqual(trusted(".common-ink/users/you@example.com/settings.json"), []);
  assert.deepEqual(trusted(".common-ink/users/sam@example.com/settings.json"), ["timers"]);
  assert.equal(JSON.parse(s.files.read(".common-ink/settings.json" as FilePath)!.text)["editor.fontSize"], 15, "the rest of the settings stay");
});

test("installing says so when it took back trust, and refuses while a settings file that trusts extensions can't be read", async () => {
  const s = store();
  const files: Record<string, string> = {
    "https://other.example/weather/extension.json": JSON.stringify({ id: "weather", name: "Weather" }),
    "https://other.example/weather/index.js": "export default { activate() {} };",
  };
  const install = () => extensionApi(post("/api/extensions/install", { url: "https://other.example/weather/" }), new URL("https://app.example/api/extensions/install"), you.email, you, s);
  await withFetch(
    (url) => (files[url] ? new Response(files[url]) : new Response("nope", { status: 404 })),
    async () => {
      write(s, ".common-ink/users/sam@example.com/settings.json", '{ "extensions.trusted": ["weather"], ');
      assert.deepEqual(await (await install())!.json(), {
        error: ".common-ink/users/sam@example.com/settings.json isn't valid JSON, so weather can't be taken out of the extensions it trusts. Fix it first.",
      });
      assert.equal(s.files.read(".common-ink/extensions/weather/index.js" as FilePath), null, "nothing was installed");
      write(s, ".common-ink/users/sam@example.com/settings.json", '{ "extensions.trusted": ["weather"] }\n');
      const res = (await (await install())!.json()) as { untrusted?: boolean };
      assert.equal(res.untrusted, true);
      assert.equal(((await (await install())!.json()) as { untrusted?: boolean }).untrusted, false);
    },
  );
});

test("the app's policy frames only the sandbox route and connects only to itself", () => {
  const csp = appCsp("https://app.example");
  assert.match(csp, /frame-src https:\/\/app\.example\/sandbox\//);
  assert.match(csp, /connect-src 'self' wss:\/\/app\.example/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.doesNotMatch(csp, /\*/);
});

test("a trusted workspace extension's imports of libraries go to the app's own copies", async () => {
  const { pointAtLibraries } = await import("../worker/src/extension-routes.ts");
  assert.equal(
    pointAtLibraries('import { Decoration } from "@codemirror/view";\nimport { livePreview } from \'common-ink/live-preview\';\nimport { x } from "./model.js";\nconst v = await import("@replit/codemirror-vim");\nimport "left-pad";'),
    'import { Decoration } from "/lib/@codemirror/view.js";\nimport { livePreview } from \'/lib/common-ink/live-preview.js\';\nimport { x } from "./model.js";\nconst v = await import("/lib/@replit/codemirror-vim.js");\nimport "left-pad";',
  );
});

test("another catalog's index is read through the safe fetch, and only its complete entries are listed", async () => {
  const s = store();
  const index = {
    name: "Friends",
    extensions: [
      { id: "weather", name: "Weather", version: "2.0.0", description: "Forecasts.", path: "weather" },
      { id: "Bad Id", name: "Nope", path: "x/" },
      { id: "script", name: "Script", path: "javascript:alert(1)" },
    ],
  };
  await withFetch(
    (url) => (url === "https://friends.example/catalog/index.json" ? Response.json(index) : new Response("nope", { status: 404 })),
    async () => {
      const read = (target: string) => {
        const url = new URL(`https://app.example/api/extensions/catalog?url=${encodeURIComponent(target)}`);
        return extensionApi(new Request(url), url, you.email, you, s);
      };
      assert.deepEqual(await (await read("https://friends.example/catalog/index.json"))!.json(), {
        entries: [{ id: "weather", name: "Weather", version: "2.0.0", description: "Forecasts.", folder: "https://friends.example/catalog/weather/", catalog: "Friends", firstParty: false, embeds: [] }],
      });
      assert.equal((await read("https://friends.example/missing.json"))!.status, 400);
      assert.deepEqual(await (await read("http://localhost:8787/catalog/index.json"))!.json(), { error: "Local names can't be fetched" });
    },
  );
});
