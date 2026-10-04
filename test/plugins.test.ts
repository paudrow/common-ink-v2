import assert from "node:assert/strict";
import { test } from "node:test";
import { activate, type Plugin, type PluginContext } from "../web/src/plugins.ts";

test("plugins start in order, settings can turn one off, and one that fails doesn't stop the rest", () => {
  const started: string[] = [];
  const plugin = (id: string, fail = false): Plugin => ({
    id,
    description: id,
    activate() {
      if (fail) throw new Error("broken");
      started.push(id);
    },
  });
  const quiet = console.error;
  console.error = () => {};
  const active = activate([plugin("a"), plugin("b"), plugin("broken", true), plugin("c")], {} as PluginContext, ["b"]);
  console.error = quiet;
  assert.deepEqual(started, ["a", "c"]);
  assert.deepEqual(active, ["a", "c"]);
});
