# Embed boxes trail their slots while scrolling

When you scroll a note with a wheel or trackpad, its embeds (a Kanban board, a timer, a video) trail the text around them. It's a few pixels on the Boards tour, and up to a slot's height on the Embeds tour, before they catch up. It was found while checking #128. This note is for deciding what, if anything, to do about it.

## Why it happens

An embed's box lives in a layer laid over the editors (`web/src/lives.ts`), not inside the editor. That's what lets a playing video or a loaded board survive its tab moving, a split, or the editor being rebuilt: moving an iframe to a new parent reloads it.

The layer follows the editor's scroll in the editor's `scroll` event, on the main thread (`follow()`). How in step it stays depends on what scrolled the editor:

- **Scrolls from code stay in step**: Vim's `Ctrl-D`, `G` and `:N`, and CodeMirror keeping the cursor in view. They set `scrollTop` on the main thread, and the `scroll` event runs before that frame is painted, so editor and layer move together.
- **Scrolls the browser makes itself trail**: wheel, trackpad, touch, and dragging the scrollbar. The browser scrolls the editor on its compositor thread and paints that at once. The layer only moves once the main thread runs the `scroll` event, a frame or more later.

## Options

1. **Put the layer inside the editor's scroller** (as CodeMirror's own selection layers are).
   - It scrolls with the text natively, in step every time.
   - Cost: the boxes then belong to one editor. A tab move, split or rebuild moves them into another, and moving an iframe to a new parent reloads it. That gives up the keep-alive design from #34.
   - `Element.moveBefore()` moves a node without taking it out of the page, so an iframe keeps its state. It's in Chrome and Edge 133+ and Firefox 144+, but not Safari yet. Where it exists, this option's main cost goes away; Safari would still reload.
   - Not recommended until Safari has `moveBefore()`.
2. **A CSS scroll-driven animation.**
   - Each editor's `.cm-scroller` gets a named scroll timeline (`scroll-timeline: --ed-N y`), with `timeline-scope` on `body` because the layer isn't inside the editor.
   - The layer's content is translated by an animation on that timeline. It runs with the scroll, and the layer stays outside the editors, so iframes stay alive.
   - Costs:
     - **Browser support:** `timeline-scope` is in Chrome and Edge 116+ and Safari 26. Firefox doesn't have it yet. Where it's missing, the layer falls back to today's behavior.
     - **Safari before 26.4:** Safari runs scroll-driven animations on its compositor only from 26.4, so on 26.0 to 26.3 the boxes would still trail.
     - **Keyframes that follow the editor:** the animation's end value must equal the editor's scroll range (its `scrollHeight` less its height). CodeMirror changes `scrollHeight` as it measures lines it hadn't drawn yet, so the keyframes have to be updated whenever it does. Until they are, the boxes are off by the change.
     - **A rewrite:** a moderate rewrite of `follow()` and `fromLayer`. The layer's own scroller (`.embed-scroller`), which takes wheel scrolls that chain out of an embed's frame, would translate rather than scroll.
   - **Recommended**, if trailing boxes matter enough for these costs.
3. **Scroll from code on wheel**: a non-passive `wheel` listener on the editor that scrolls both editor and layer itself.
   - Fixes wheel and trackpad only. Touch and scrollbar drags still trail.
   - Loses the browser's smooth scrolling, and makes every scroll of a long note wait for the main thread. **Not recommended.**

Leaving it as it is costs a short visual lag while scrolling, and nothing else: boxes land on their slots as soon as scrolling settles.

## How to test a fix

JavaScript can't see what was painted in a frame. A check run from `requestAnimationFrame`, or from a task after a frame, sees layout the compositor hasn't shown yet, or has already moved past. Use frame screenshots instead:

1. In a browser test, start Chrome tracing over CDP (`Tracing.start`) with the `disabled-by-default-devtools.screenshot` category.
2. Scroll with real wheel events (`page.mouse.wheel`), a few notches over a second or two, on the Boards tour and the Embeds tour.
3. Stop tracing. For each screenshot, compare an embed box's edge with its slot's. Give the slot a temporary 1px outline in a colour nothing else uses (a test-only style), and find the box's top edge in the same column.
4. Count frames where the two are more than 1px apart. A fix should get it to 0, against several per scroll today.

A between-frame check from JavaScript also flags viewport resizes emulated over CDP, which are never painted misaligned, so the screenshot count is the one to trust.

## Sources

- MDN browser compatibility data: [`timeline-scope`](https://developer.mozilla.org/en-US/docs/Web/CSS/timeline-scope#browser_compatibility), [`animation-timeline`](https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline#browser_compatibility), [`Element.moveBefore()`](https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore#browser_compatibility).
- [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/): scroll-driven animations.
- [WebKit Features for Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/): threaded scroll-driven animations, run on the compositor.
