# Extension architecture

Supersedes ADR 0005. Plugins are now called extensions.

Common Ink is a small core with almost everything else built as extensions, on the same public API anyone can use. The core is the file store and sync, history, the layout model, the command registry and command bar shell, the settings store and settings editor, the Extensions view, the permission broker, safe mode, and a plain editor. Settings and the Extensions view stay in the core, so turning extensions off can never lock you out of turning them back on. Vim keys, live preview, todos, history's view, the command bar's providers, calendar, contacts, uploads, and even tab bars and window chrome are extensions, on by default, that you can turn off or customize. The layout model (`layout.json`, the tree of areas, windows and views, and focus) is core, with a plain fallback renderer. Drawing tabs, splits and the rest is the default Workbench extension's job.

## A manifest says what an extension is

Each extension is a folder with an `extension.json`. Built-ins ship that way in `web/src/extensions/<id>/`, and workspace extensions live in `.common-ink/extensions/<id>/`, where they're files with history like any note. The manifest gives the id, name, version, description, main module, activation events, permissions and contributions. Contributions cover commands, keybindings (keys and Vim sequences), menus, a settings section (`configuration`, as JSON Schema), view containers and views, status bar items, embeds and URL embeds. The app reads every manifest at load and puts all of it in place before any extension code runs. Commands show in the command bar, settings get their own section in the settings editor, and the Extensions view lists what each extension adds and may ask for. An extension's code starts only when one of its activation events happens: `onStartup`, or `onCommand:…`, `onView:…`, `onEmbed:…` the first time that command runs, that view shows, or that embed draws. Code can only fill in what the manifest declares. Registering a command or view the manifest doesn't declare is an error.

A workspace extension with a built-in's id runs in its place. That's how Customize works: it copies a built-in's files into the workspace for you to change. Revert deletes the copy, through history.

## Two trust tiers

**Sandboxed is the default** for everything that isn't built in or explicitly trusted. An extension's code runs in its own extension host, a hidden iframe with `sandbox="allow-scripts"` and nothing else. That gives it an opaque origin, so it can't touch the app's cookies, storage or page. It talks to the app only through a typed postMessage RPC, and that RPC is the public API. The host persists across tab changes, so a timer keeps running when its note closes. Its UI is drawn in webviews: sandboxed iframes with the same policy, in a view container, a tab or a note. Each webview talks to its own host through the app.

**Trusted extensions run in the page.** These are built-ins, plus extensions you mark trusted, which is recorded in settings like VS Code's Workspace Trust. They use the same manifest and the same API. On top of that, they can change note editors (CodeMirror decorations, keys, live preview) and draw views straight into the page, because both need the page's editor and DOM synchronously.

## Permissions are asked for at the moment of use

The manifest declares the most an extension can ever ask for, each with a reason ("why"), as iOS apps declare usage descriptions. Anything undeclared can never be granted. The kinds are:

- `network`, by host
- `files:read` and `files:write`, by path glob (an extension's own state file is always allowed)
- `clipboard:read` and `clipboard:write`
- `notifications`
- `media`
- `history:read`
- `calendar:read` and `contacts:read`
- `settings:write`, outside the extension's own section
- `editor`, trusted only

Permissions are asked for on first use, at runtime. The call waits while a prompt says who wants what and why: Allow once, Always allow, or Don't allow. Denying rejects the call, and the app doesn't ask again until you change it in the Extensions view. Answers live in settings, under `extensions.permissions.<id>`, so they're visible, editable, recorded in history and synced. Allow once lasts for the session.

What extensions do is observable. Their writes are changes in history, by `extension:<id>`. Their network requests and reads go in an Extension activity view, and a status bar dot shows while a request is in flight.

## What the sandbox guarantees, and what it doesn't

A sandboxed extension can't reach the network except through the brokered `fetch` in its API. The app's Worker does that fetch for it, after checking the grant. The fetch sends no credentials and no referrer, and it refuses anything but http(s) to public hosts, with size and time limits. The sandbox's Content Security Policy is `connect-src 'none'`, with images, media and fonts only from the sandbox route, `data:` and `blob:`. The app's own policy limits `frame-src` to the sandbox route and the hosts of URL embeds that are on. That stops a sandboxed frame from navigating itself to another site with data in the address (see the findings below).

Trusted extensions run in the page, so they can get around the broker, for example by calling the app's own endpoints directly. For them, permissions are declared and best-effort, and the hard guarantee holds only for sandboxed extensions. The trust prompt says so. That's why as much as possible runs in the sandbox.

## Findings that shaped this

These were checked in headless Chrome against a test server.

- In a `sandbox="allow-scripts"` iframe, the CSP source `'self'` still matches the document URL's origin, even though the document's own origin is opaque: a script from `/classic.js` loaded. The sandbox's policy names its sources by full origin and path anyway (`https://<host>/sandbox/`), which is narrower than `'self'` and doesn't depend on that behavior.
- Module scripts loaded from an opaque origin are CORS requests. The sandbox route answers them with `Access-Control-Allow-Origin: *`.
- An iframe's own navigation sends the app's cookies. Requests made from inside the sandboxed frame are cross-site and send no `SameSite=Lax` cookies. So the sandbox route needs no cookies: it serves public code (vendored libraries) or code authorized by a short-lived token in its address.
- Content written into the sandboxed frame with `document.write` runs. In there, `document.cookie` and `localStorage` throw `SecurityError`, `fetch` is blocked by `connect-src 'none'`, and `window.open` returns null.
- A sandboxed frame can navigate itself to another site, which would carry data out in the address. The parent page's `frame-src` stops it: with the app's policy naming only the test server, the frame's navigation to another host was blocked before any request went out.

## What building it changed

- **A sandboxed frame that navigates is stopped, not just blocked.** The app's `frame-src` blocks a frame leaving the sandbox route, which leaves it on an error page. The app notices (the host frame loads again; a webview stops answering its ping) and stops that extension or webview, and says why.
- **Webviews are written, not loaded.** A webview's shell is a fixed page from the sandbox route; the extension's HTML arrives over its port and replaces the page with `document.write`. Its `commonInk` API and its port survive that. That keeps one public shell for every webview, with no extension HTML served by URL.
- **Trusted extensions may draw views straight into the page** (`render(el)`), as well as webviews (`resolve(webview)`). History, Calendar and the rest share the app's styles, focus and keyboard handling that way; a webview couldn't, and for code that runs in the page anyway, it would buy no safety.
- **"Allow once" is the page's word.** The Worker checks a brokered fetch against your kept answers, but it can't see a prompt, so a fetch marked "once" by the page is believed if the manifest declares the host. Code in the page could claim it; code in a sandbox can't reach the Worker at all.
- **Answers are kept in your user settings**, since they're your consent, not the workspace's.
- **The activity bar, sidebar and bottom panel arrive with the Workbench extension**, where the layout model is redesigned anyway, so the layout API is designed once. Status bar items came first, for Vim's mode.
- **Built-ins import libraries, not the app.** An extension's code imports its own folder's files and a short list of libraries by name: CodeMirror's packages, codemirror-vim, and a few of the app's modules (`common-ink/live-preview`, `common-ink/files`, …). The app is built so a built-in's chunk gets the app's instances. In a workspace extension, the Worker points those names at `/lib/<name>.js`, small modules that hand over the same instances. So a customized copy of any built-in, Vim included, runs as it did, and CodeMirror is one copy. Customize copies the JavaScript the build makes from the TypeScript.
- **Built-ins load on their activation events.** Their code is a chunk each, fetched when an event fires; their sources (for Source) and copies (for Customize) load when asked for. The app's first download (its entry script and the modules it preloads) went from 756 kB (240 kB gzipped) to 591 kB (196 kB gzipped). Built-ins that start with the app (Vim, Live preview, Todos, Uploads, the command bar's) load right after.
- **Vim is an extension like any other.** The core has standard keys and commands for everything. Vim's manifest binds Vim sequences to those commands (`gt`, `Ctrl-W h`, `gd`, …), and its code defines the ex commands (`:e`, `:w`, `:vs`, `:tabm`) on the workbench API, shows the mode as a status bar item, and maps every extension's `vim` keybindings. Ctrl-O and Ctrl-I go through Vim's jumps, then the core's Go back and Go forward. The `editor.vim` setting is gone: Vim is on or off in the Extensions view.
- **Live preview's mechanism is a library; its markdown is an extension.** Todos, uploads and markdown all draw through the mechanism (`common-ink/live-preview`), and the core's `editor.livePreview` setting turns every extension's previews off and on at once, without a reload.
- **The Catalog is served by the app.** First-party extensions that aren't on by default (Word count now; more as they're built) are installed from `/catalog/`, as workspace extensions, so they run sandboxed like anyone's. Other catalogs come in through the `extensions.catalogs` setting and the Worker's safe fetch, and the view says installing from them is at your own risk.

## Consequences

- One manifest format and one API for built-ins and everyone else, so the API is proven by the app's own features.
- Lazy activation keeps startup and the core bundle small.
- Extensions that need the page are trusted and best-effort, and the Extensions view and the trust prompt say so plainly.
- There is no community registry yet. Installing from a URL copies an extension's files into the workspace, sandboxed by default. A catalog of first-party extensions that aren't on by default comes from the app. A community catalog would plug in at the same seam, with "at your own risk" wording.
