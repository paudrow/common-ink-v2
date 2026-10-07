import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "../worker/src/extensions.ts";
import { declaredPermissions, fileWords, filesWords, hostWords, plain, scopeWords } from "../web/src/permission-words.ts";

test("a glob over paths says how far it really reaches", () => {
  assert.equal(plain(filesWords("**")), "all your files");
  assert.equal(plain(filesWords("**/*.md")), "all your notes");
  assert.equal(plain(filesWords("Journal/**")), "everything in Journal");
  assert.equal(plain(filesWords("Projects/Work/**/*.md")), "your notes in Projects/Work");
  assert.equal(plain(filesWords(".common-ink/**")), "the app's own files");
  assert.equal(plain(filesWords("Journal/*.txt")), "files matching Journal/*.txt");
});

test("one file goes by its friendly name, never an internal path", () => {
  assert.deepEqual(fileWords("Plans/This week.md"), ["the note ", { name: "Plans/This week" }]);
  assert.deepEqual(fileWords(".common-ink/users/ada@example.com/settings.json"), [{ name: "User settings" }]);
  assert.equal(plain(fileWords(".common-ink/settings.json")), "Workspace settings");
  assert.equal(plain(fileWords(".common-ink/uploads.json")), "Uploads list");
  assert.equal(plain(fileWords("photos/cat.png")), "the file photos/cat.png");
  assert.equal(plain(filesWords("Plans/This week.md")), "the note Plans/This week", "a glob with no wildcard is one file");
});

test("hosts, and each kind of permission, read as what they let it do", () => {
  assert.equal(plain(hostWords("api.weather.gov")), "api.weather.gov");
  assert.equal(plain(hostWords("*.example.com")), "any site under example.com");
  assert.equal(plain(hostWords("*")), "any site");
  assert.deepEqual(
    [
      scopeWords("network", "api.weather.gov"),
      scopeWords("files:read", "**/*.md"),
      scopeWords("files:write", "**"),
      scopeWords("files:write", ".common-ink/uploads.json"),
      scopeWords("settings:write", "editor.fontSize"),
      scopeWords("clipboard:read"),
      scopeWords("clipboard:write"),
      scopeWords("notifications"),
      scopeWords("media"),
      scopeWords("history:read"),
      scopeWords("data:calendar:read"),
      scopeWords("data:calendar:write"),
      scopeWords("data:contacts:read"),
      scopeWords("editor"),
    ].map(plain),
    [
      "connect to api.weather.gov",
      "read all your notes",
      "change all your files",
      "save files you upload (Uploads list)",
      "change the setting editor.fontSize",
      "read your clipboard",
      "copy to your clipboard",
      "show notifications",
      "play sound",
      "read the history of your files",
      "see your calendar's events",
      "add, change and delete events in your calendar",
      "see your contacts",
      "change how notes are edited and drawn",
    ],
  );
});

test("a manifest's permissions, one per scope, as answers are kept and as the app says them", () => {
  const m = parseManifest(
    {
      name: "Weather",
      permissions: {
        network: { hosts: ["api.weather.gov", "*.noaa.gov"], why: "Fetch forecasts" },
        "files:read": { paths: ["**/*.md"], why: "Find places in your notes" },
        notifications: { why: "Warn about storms" },
      },
    },
    "weather",
  );
  if (typeof m === "string") throw new Error(m);
  assert.deepEqual(
    declaredPermissions(m).map((p) => [p.key, plain(p.can), p.why]),
    [
      ["network:api.weather.gov", "Connect to api.weather.gov", "Fetch forecasts"],
      ["network:*.noaa.gov", "Connect to any site under noaa.gov", "Fetch forecasts"],
      ["files:read:**/*.md", "Read all your notes", "Find places in your notes"],
      ["notifications", "Show notifications", "Warn about storms"],
    ],
  );
});

test("an ask says the one thing it's for, in the tense each place needs", async () => {
  const { askWords } = await import("../web/src/permission-words.ts");
  const { activityWords } = await import("../web/src/activity.ts");
  const read = { kind: "files:read" as const, target: "Plans/This week.md" };
  assert.equal(plain(askWords(read)), "read the note Plans/This week");
  assert.equal(plain(askWords({ kind: "files:read", target: ".common-ink/users/ada@example.com/settings.json" })), "read User settings");
  assert.equal(plain(askWords({ kind: "files:read", scope: "**/*.md" })), "read all your notes");
  assert.equal(plain(askWords({ kind: "files:write", scope: ".common-ink/uploads.json" })), "save files you upload (Uploads list)");
  assert.equal(plain(askWords({ kind: "network", target: "api.weather.gov" })), "connect to api.weather.gov");
  assert.deepEqual(
    [
      activityWords({ ask: read, outcome: "allowed" }),
      activityWords({ ask: read, outcome: "denied" }),
      activityWords({ ask: { kind: "network", target: "api.weather.gov" }, outcome: "in flight" }),
      activityWords({ ask: { kind: "network", target: "api.weather.gov" }, outcome: "failed" }),
      activityWords({ ask: { kind: "clipboard:write" }, outcome: "allowed" }),
      activityWords({ ask: { kind: "notifications" }, outcome: "allowed" }),
    ].map(plain),
    [
      "read the note Plans/This week",
      "wasn't allowed to read the note Plans/This week",
      "is connecting to api.weather.gov…",
      "couldn't connect to api.weather.gov",
      "copied to your clipboard",
      "showed a notification",
    ],
  );
});

test("why now: what you did that the extension is acting on, or that it asked on its own", async () => {
  const { triggerWords } = await import("../web/src/permission-words.ts");
  assert.deepEqual(
    [
      triggerWords({ kind: "command", title: "Show word count" }),
      triggerWords({ kind: "view", name: "Reading time" }),
      triggerWords({ kind: "opened", path: ".common-ink/settings.json" }),
      triggerWords({ kind: "embed", title: "Weather", note: "Daily plan.md" }),
      triggerWords({ kind: "installed" }),
      triggerWords({ kind: "turnedOn" }),
      triggerWords({ kind: "startup" }),
      triggerWords(null),
    ].map(plain),
    [
      "because you ran Show word count",
      "to show its Reading time view",
      "because you switched to Workspace settings",
      "to draw the Weather embed in the note Daily plan",
      "because you just installed it",
      "because you just turned it on",
      "as the app started",
      "on its own, not right after anything you did",
    ],
  );
});

test("a refusal says what was refused and why, in friendly names", async () => {
  const { refusedWords, scopeWords } = await import("../web/src/permission-words.ts");
  const settings = { kind: "files:read" as const, target: ".common-ink/users/ada@example.com/settings.json" };
  assert.equal(plain(refusedWords("Reading time", settings, { reason: "undeclared", scopes: ["**/*.md"] })), "Reading time can't read User settings: it only asked to read all your notes.");
  assert.equal(plain(refusedWords("Reading time", settings, { reason: "undeclared", scopes: ["Journal/**", "Plans/**/*.md", "Ideas.md"] })), "Reading time can't read User settings: it only asked to read everything in Journal, your notes in Plans or the note Ideas.");
  assert.equal(plain(refusedWords("Weather", { kind: "network", target: "evil.example" }, { reason: "undeclared", scopes: [] })), "Weather can't connect to evil.example: it never asked for that.");
  assert.equal(plain(refusedWords("Reading time", { kind: "files:read", target: "This week.md" }, { reason: "answer", scope: scopeWords("files:read", "**/*.md") })), "Reading time can't read the note This week: you don't allow it to read all your notes.");
  assert.equal(plain(refusedWords("Reading time", { kind: "files:read", target: "This week.md" }, { reason: "now" })), "Reading time can't read the note This week: you didn't allow it this time.");
});

test("the activity log says the same thing done again in a row once, with how many times", async () => {
  const { runs } = await import("../web/src/activity.ts");
  const read = (target: string, time: number) => ({ time, extension: "reading-time", ask: { kind: "files:read" as const, target }, outcome: "allowed" as const });
  assert.deepEqual(
    runs([read("A.md", 5), read("A.md", 4), read("B.md", 3), read("A.md", 2), read("A.md", 1)]).map((r) => [r.entry.ask.target, r.entry.time, r.times]),
    [
      ["A.md", 5, 2],
      ["B.md", 3, 1],
      ["A.md", 2, 2],
    ],
  );
});
