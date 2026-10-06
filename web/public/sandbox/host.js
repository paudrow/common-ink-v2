// An extension host: the hidden, sandboxed frame a sandboxed extension's code runs in (ADR 0006). Its
// origin is opaque, its policy lets nothing connect out, and it talks to the app only over the
// MessagePort the app hands it. This file builds the extension's `ctx` from that port: every method
// is a message to the app, which checks the extension's manifest and permissions before doing it.
(() => {
  let port = null;
  let me;
  let settings = {};
  let next = 0;
  const calls = new Map();
  const handlers = new Map();
  const listeners = { saved: [], focus: [], records: [] };
  const webviewListeners = new Map();
  let providers = 0;
  let items = 0;

  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = `h${++next}`;
      calls.set(id, { resolve, reject });
      port.postMessage({ t: "call", id, method, args });
    });

  const report = (message) => port && port.postMessage({ t: "error", message: String(message) });
  addEventListener("error", (e) => report(e.message));
  addEventListener("unhandledrejection", (e) => report(e.reason && e.reason.message ? e.reason.message : e.reason));

  // The command bar's matching, the same as the app's: the query's characters in order, word starts
  // and runs scoring higher.
  function fuzzyScore(query, text) {
    const q = query.toLowerCase().replace(/\s+/g, "");
    const t = text.toLowerCase();
    if (!q) return 0;
    let best = null;
    for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
      let score = 0;
      let last = start - 2;
      let at = start;
      let ok = true;
      for (const ch of q) {
        at = t.indexOf(ch, at);
        if (at < 0) {
          ok = false;
          break;
        }
        score += 1 + (at === last + 1 ? 3 : 0) + (at === 0 || /[\s/_.-]/.test(t[at - 1]) ? 2 : 0);
        last = at;
        at++;
      }
      if (ok && (best === null || score > best)) best = score;
    }
    return best === null ? null : best - t.length / 100;
  }

  const fuzzyFilter = (query, list, text) =>
    list
      .map((item, i) => ({ item, i, score: fuzzyScore(query, text(item)) }))
      .filter((m) => m.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((m) => m.item);

  /** The handle on a webview, the same one each time: an update to an embed reaches the page it resolved. */
  const webviewHandles = new Map();
  function webview(id) {
    if (webviewHandles.has(id)) return webviewHandles.get(id);
    let html = "";
    const own = [];
    webviewListeners.set(id, own);
    const handle = {
      get html() {
        return html;
      },
      set html(value) {
        html = String(value);
        void call("webview.html", id, html);
      },
      post: (message) => call("webview.post", id, message),
      onMessage: (fn) => void own.push(fn),
    };
    webviewHandles.set(id, handle);
    return handle;
  }

  function context(extension) {
    return {
      extension,
      me,
      settings: { get: (key) => settings[key] },
      commands: {
        register(id, run) {
          handlers.set(`command:${id}`, run);
          return call("commands.register", id);
        },
        run: (id) => call("commands.run", id),
        all: () => call("commands.all"),
        shortcut: (id) => call("commands.shortcut", id),
        keybindings: () => call("commands.keybindings"),
      },
      statusBar: { set: (id, text, tooltip) => call("statusBar.set", id, text, tooltip) },
      commandBar: {
        provide(provider) {
          const id = String(++providers);
          handlers.set(`provider:${id}`, async (query) =>
            (await provider.items(query)).map((item) => {
              const run = `${id}:${++items}`;
              handlers.set(`item:${run}`, () => item.run());
              return { label: item.label, detail: item.detail, run };
            }),
          );
          return call("commandBar.provide", id, provider.prefix, provider.placeholder);
        },
        open: (text) => call("commandBar.open", text),
      },
      search: {
        provide(type, provider) {
          // Each search's results replace the last one's, so their handlers don't pile up.
          let previous = [];
          handlers.set(`search:${type}`, async (query, limit, within) => {
            for (const run of previous) handlers.delete(`item:${run}`);
            previous = [];
            return (await provider.search(query, limit, within)).map((result) => {
              const run = `search-${type}:${++items}`;
              previous.push(run);
              handlers.set(`item:${run}`, () => result.run());
              return { title: result.title, path: result.path, detail: result.detail, aside: result.aside, dim: result.dim, run };
            });
          });
          return call("search.provide", type);
        },
        find: (text, limit) => call("search.find", text, limit),
        filterKeys: () => call("search.filterKeys"),
      },
      embeds: {
        register(language, provider) {
          handlers.set(`embed:${language}`, (webviewId, embed) => provider.resolve(webview(webviewId), embed));
          // New arguments or body for an embed it drew, in place: the app only sends them if it said it can take them.
          if (provider.update) handlers.set(`embedUpdate:${language}`, (webviewId, embed) => provider.update(webview(webviewId), embed));
          return call("embeds.register", language, typeof provider.update === "function");
        },
      },
      state: { get: () => call("state.get"), set: (value) => call("state.set", value) },
      views: {
        register(id, provider) {
          handlers.set(`view:${id}`, (webviewId) => provider.resolve(webview(webviewId)));
          return call("views.register", id);
        },
        show: (id) => call("views.show", id),
        toggle: (id) => call("views.toggle", id),
        refresh: (id) => call("views.refresh", id),
        open: (id, how) => call("views.open", id, how),
      },
      files: {
        list: () => call("files.list"),
        read: (path) => call("files.read", path),
        write: (path, text, base) => call("files.write", path, text, base),
      },
      net: { fetch: (url, init) => call("net.fetch", url, init || {}), card: (url) => call("net.card", url) },
      clipboard: { read: () => call("clipboard.read"), write: (text) => call("clipboard.write", text) },
      notifications: { show: (title, body) => call("notifications.show", title, body) },
      data: {
        status: () => call("data.status"),
        sync: (force) => call("data.sync", force ? "force" : null),
        calendar: {
          calendars: () => call("data.calendars"),
          events: (from, to, calendars) => call("data.events", from.toISOString(), to.toISOString(), calendars || null),
          event: (address) => call("data.event", address),
          create: (event) => call("data.create", null, event),
          update: (address, change, scope) => call("data.update", address, change, scope || null),
          remove: (address, scope) => call("data.remove", address, scope || null),
          onChange: (fn) => void listeners.records.push(fn),
        },
        contacts: { search: (query) => call("data.contacts", query || "") },
      },
      workbench: {
        open: (path, how) => call("workbench.open", path, how),
        focusedPath: () => call("workbench.focusedPath"),
        hasUnsavedChanges: () => call("workbench.hasUnsavedChanges"),
        split: (direction, path) => call("workbench.split", direction, path),
        tabs: () => call("workbench.tabs"),
        moveTab: (by) => call("workbench.moveTab", by),
        notice: (message) => call("workbench.notice", message),
      },
      events: {
        onSaved: (fn) => void listeners.saved.push(fn),
        onFocus: (fn) => void listeners.focus.push(fn),
        // Every change's path, whatever the extension may read: only trusted extensions hear them.
        onChange: () => {
          throw new Error("ctx.events.onChange isn't available to sandboxed extensions: trust this extension in the Extensions view to use it");
        },
      },
      util: { fuzzyFilter, label: (path) => path.replace(/\.md$/, "") },
    };
  }

  async function onMessage(e) {
    const m = e.data;
    if (m.t === "start") {
      me = m.me;
      settings = m.settings || {};
      try {
        const mod = await import(m.code);
        if (!mod.default || typeof mod.default.activate !== "function") throw new Error(`${m.extension.main} must export default { activate(ctx) { … } }`);
        await mod.default.activate(context(m.extension));
        port.postMessage({ t: "ready" });
      } catch (err) {
        port.postMessage({ t: "failed", message: err && err.message ? err.message : String(err) });
      }
    } else if (m.t === "result" || m.t === "reject") {
      const pending = calls.get(m.id);
      calls.delete(m.id);
      if (pending && m.t === "result") pending.resolve(m.value);
      else if (pending) pending.reject(new Error(m.message));
    } else if (m.t === "invoke") {
      const fn = handlers.get(m.handler);
      try {
        if (!fn) throw new Error(`Nothing handles ${m.handler}`);
        port.postMessage({ t: "result", id: m.id, value: (await fn(...m.args)) ?? null });
      } catch (err) {
        port.postMessage({ t: "reject", id: m.id, message: err && err.message ? err.message : String(err) });
      }
    } else if (m.t === "event") {
      if (m.name === "settings") settings = m.args[0];
      else if (m.name === "webview.message") for (const fn of webviewListeners.get(m.args[0]) || []) fn(m.args[1]);
      else for (const fn of listeners[m.name] || []) fn(...m.args);
    }
  }

  addEventListener("message", (e) => {
    if (e.source !== parent || port || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = (ev) => void onMessage(ev);
  });
})();
