import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectFor } from "../worker/src/hosts.ts";

test("www goes to the apex, keeping the path and query", () => {
  assert.deepEqual(redirectFor(new URL("https://www.commonink.app/?file=Plan.md")), { location: "https://commonink.app/?file=Plan.md", status: 301 });
  assert.deepEqual(redirectFor(new URL("https://www.commonink.app/auth/google?next=/")), { location: "https://commonink.app/auth/google?next=/", status: 301 });
});

test("links kept from v1 go on to v1.commonink.app", () => {
  assert.deepEqual(redirectFor(new URL("https://commonink.app/s/abc123")), { location: "https://v1.commonink.app/s/abc123", status: 302 });
  assert.deepEqual(redirectFor(new URL("https://commonink.app/notes/sync-k3x9q2mf")), { location: "https://v1.commonink.app/notes/sync-k3x9q2mf", status: 302 });
  assert.deepEqual(redirectFor(new URL("https://commonink.app/invite/tok?x=1")), { location: "https://v1.commonink.app/invite/tok?x=1", status: 302 });
  assert.deepEqual(redirectFor(new URL("https://commonink.app/docs/agents")), { location: "https://v1.commonink.app/docs/agents", status: 302 });
  assert.deepEqual(redirectFor(new URL("https://commonink.app/privacy.html")), { location: "https://v1.commonink.app/privacy.html", status: 302 });
  assert.deepEqual(redirectFor(new URL("https://commonink.app/terms")), { location: "https://v1.commonink.app/terms", status: 302 });
});

test("v2's own addresses stay here", () => {
  for (const url of ["https://commonink.app/", "https://commonink.app/?file=notes/Plan.md", "https://commonink.app/api/file?path=s/x.md", "https://commonink.app/mcp", "https://commonink.app/auth/google/callback", "https://commonink.app/sandbox/x", "https://commonink.app/notesy", "https://pr-12-common-ink-v2.draftox.workers.dev/"]) {
    assert.equal(redirectFor(new URL(url)), null, url);
  }
});
