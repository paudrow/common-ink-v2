// The layer embeds' boxes live in (lives.ts) costs nothing while nothing happens, and stands in for the
// window under it: focus in a box focuses its window, and a tab dragged over a box drops on that window.
// Its boxes look as they did inside the editor: they take the text styles of the editor's content.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

/** How many animation frame callbacks the page runs in `ms`, once it's had a moment to settle. */
async function framesWhileIdle(app: App, ms = 3000): Promise<number> {
  await app.idle();
  await app.page.mouse.move(1, 1);
  await app.page.waitForTimeout(1000);
  return app.page.evaluate(
    (ms) =>
      new Promise<number>((done) => {
        const original = window.requestAnimationFrame;
        let n = 0;
        window.requestAnimationFrame = (f) => original((t) => (n++, f(t)));
        setTimeout(() => {
          window.requestAnimationFrame = original;
          done(n);
        }, ms);
      }),
    ms,
  );
}

browserTest(h, "idle, the page runs no frame after frame: a plain note, a note full of embeds, and five tabs of them", { scenario: "embeds" }, async (app) => {
  await app.writeFile("Plain.md", "# Plain\n\nNothing drawn here.\n");
  await app.open("Plain");
  const plain = await framesWhileIdle(app);
  assert.ok(plain <= 3, `a plain note: ${plain} frames in 3s`);
  await app.open("Embeds tour");
  await app.page.locator(".cm-embed[data-live]").first().waitFor();
  const one = await framesWhileIdle(app);
  assert.ok(one <= 3, `a note of embeds: ${one} frames in 3s`);
  for (const note of ["Link embeds tour", "Markdown extras", "Three.js scene", "Plain"]) await app.page.locator("#notes a", { hasText: note }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.waitForFunction(() => document.querySelectorAll(".tab").length >= 5);
  const five = await framesWhileIdle(app);
  assert.ok(five <= 3, `five tabs: ${five} frames in 3s`);
});

/** The box in the window at `index`, of the ones with a Settings button, whose middle is in that window. */
async function boxIn(app: App, index: number) {
  return app.page.evaluate((index) => {
    const win = document.querySelectorAll(".group")[index].querySelector(".editors")!.getBoundingClientRect();
    const box = [...document.querySelectorAll<HTMLElement>(".cm-embed[data-live]")].find((b) => {
      const r = b.getBoundingClientRect();
      return getComputedStyle(b).visibility === "visible" && r.height > 30 && r.left >= win.left && r.right <= win.right + 1 && r.top > win.top && r.bottom < win.bottom && !!b.querySelector(".cm-embed-tools button");
    });
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { key: box.dataset.live!, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, index);
}

const focusedWindow = (app: App) => app.page.evaluate(() => [...document.querySelectorAll(".group")].findIndex((g) => g.classList.contains("focused")));

browserTest(h, "focus in an embed's box focuses its window, as it did when the box was in it", { scenario: "embeds", open: "Embeds tour" }, async (app) => {
  await app.page.locator(".cm-embed[data-live]").first().waitFor();
  await app.command("Split right");
  await app.page.waitForFunction(() => document.querySelectorAll(".group").length === 2);
  assert.equal(await focusedWindow(app), 1, "the new window is focused");
  const left = (await boxIn(app, 0))!;
  assert.ok(left, "a box with Settings in the left window");
  // Its toolbar shows on hover; its Settings button takes focus.
  await app.page.mouse.move(left.x, left.y);
  const settings = app.page.locator(`.cm-embed[data-live="${left.key}"] .cm-embed-tools button`, { hasText: "Settings" });
  const boxes = await settings.count();
  let clicked = false;
  for (let i = 0; i < boxes && !clicked; i++) {
    const b = await settings.nth(i).boundingBox();
    if (b && Math.abs(b.x - left.x) < 400 && b.x < (await app.page.evaluate(() => document.querySelectorAll(".group")[1].getBoundingClientRect().left))) {
      await settings.nth(i).click();
      clicked = true;
    }
  }
  assert.ok(clicked, "clicked the left box's Settings");
  await app.page.waitForFunction(() => document.querySelectorAll(".group")[0].classList.contains("focused"));
  assert.equal(await focusedWindow(app), 0, "the left window is focused now");
});

browserTest(h, "a tab dragged over an embed's box drops on the window under it", { scenario: "embeds", open: "Embeds tour" }, async (app) => {
  await app.page.locator(".cm-embed[data-live]").first().waitFor();
  await app.command("Split right");
  await app.page.waitForFunction(() => document.querySelectorAll(".group").length === 2);
  await app.page.waitForTimeout(500);
  const tab = (await app.page.locator(".group").nth(1).locator(".tab").first().boundingBox())!;
  const over = (await boxIn(app, 0))!;
  assert.ok(over, "a box in the left window");
  await app.page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await app.page.mouse.down();
  for (let i = 1; i <= 15; i++) await app.page.mouse.move(tab.x + tab.width / 2 + ((over.x - tab.x - tab.width / 2) * i) / 15, tab.y + tab.height / 2 + ((over.y - tab.y - tab.height / 2) * i) / 15);
  assert.equal(await app.page.locator(".group").nth(0).locator(".drop:not([hidden])").count(), 1, "the drop overlay shows over the box");
  await app.page.mouse.up();
  await app.page.waitForFunction(() => document.querySelectorAll(".group").length === 1);
  // The boxes take pointers again once the drag is over.
  assert.equal(await app.page.evaluate(() => document.querySelector(".embed-layer")!.classList.contains("is-passing")), false);
});

browserTest(h, "a box takes the text styles of the editor's scroller, where boxes were, line height scaling with each font size", { scenario: "embeds", open: "Embeds tour" }, async (app) => {
  await app.page.locator(".cm-embed[data-live]").first().waitFor();
  const styles = await app.page.evaluate(() => {
    const props = ["font-family", "font-size", "line-height", "white-space", "letter-spacing"];
    // A child in a bigger font, in each: its line height is the same in both.
    const of = (parent: Element) => {
      const probe = document.createElement("span");
      probe.style.fontSize = "1.4em";
      parent.append(probe);
      const out = props.map((p) => getComputedStyle(probe).getPropertyValue(p));
      probe.remove();
      return out;
    };
    const box = [...document.querySelectorAll(".cm-embed[data-live]")].find((b) => getComputedStyle(b).visibility === "visible")!;
    return { scroller: of(document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!), box: of(box.parentElement!) };
  });
  assert.deepEqual(styles.box, styles.scroller);
});

browserTest(h, "idle, a note with embeds isn't measured again and again: nothing around the editors changes", { scenario: "tasks", open: "Boards tour" }, async (app) => {
  await app.page.locator(".cm-embed[data-live]").first().waitFor();
  await app.idle();
  await app.page.waitForTimeout(1500);
  const measured = await app.page.evaluate(
    () =>
      new Promise<number>((done) => {
        const original = Element.prototype.getBoundingClientRect;
        let n = 0;
        Element.prototype.getBoundingClientRect = function (this: Element) {
          if (this.classList.contains("cm-scroller")) n++;
          return original.call(this);
        };
        setTimeout(() => {
          Element.prototype.getBoundingClientRect = original;
          done(n);
        }, 3000);
      }),
  );
  assert.ok(measured <= 3, `the editor measured ${measured} times in 3s`);
});
