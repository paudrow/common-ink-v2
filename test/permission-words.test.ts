import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "../worker/src/extensions.ts";
import { declaredPermissions, fileWords, filesWords, hostWords, plain, scopeWords } from "../web/src/permission-words.ts";

test("a glob over paths says how far it really reaches", () => {
  assert.equal(plain(filesWords("**")), "all your files, including settings");
  assert.equal(plain(filesWords("**/*.md")), "all your notes");
  assert.equal(plain(filesWords("Journal/**")), "everything in Journal");
  assert.equal(plain(filesWords("Projects/Work/**/*.md")), "your notes in Projects/Work");
  assert.equal(plain(filesWords(".common-ink/**")), "your settings and the app's own files");
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
      scopeWords("calendar:read"),
      scopeWords("contacts:read"),
      scopeWords("editor"),
    ].map(plain),
    [
      "connect to api.weather.gov",
      "read all your notes",
      "change all your files, including settings",
      "save files you upload (Uploads list)",
      "change the setting editor.fontSize",
      "read your clipboard",
      "copy to your clipboard",
      "show notifications",
      "play sound",
      "read the history of your files",
      "read your calendar",
      "read your contacts",
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
