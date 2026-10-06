# Security

How Common Ink v2 is defended: what it protects, from whom, where the trust boundaries are, what holds each one, and what's still open. Read it before you change sign-in, the Worker's routes, the sandbox, the permission broker or the safe fetch, and update it when one of them changes.

## Reporting a problem

Report a vulnerability privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Don't open a public issue or pull request for it. Say what an attacker can do and how, with the smallest steps that show it, and test only against `npm run dev` or a Preview, never commonink.app or v1.commonink.app.

## What's protected

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Notes, files, history and labels | The workspace's Durable Object (SQLite) | The workspace itself. History can bring back anything ever written. |
| Uploads | R2, by SHA-256; names in `.common-ink/uploads.json` | Pictures and documents people keep. |
| Google refresh tokens | The `connections` table, sealed with AES-GCM under a key from `SESSION_SECRET` (`token-seal.ts`) | Long-lived read and write access to everyone's calendar and read access to contacts. |
| Calendar events and contacts | Records under `.common-ink/records/`, contacts fetched live | Other people's names, addresses and meetings. |
| Sessions | `__Host-ci_session`, HMAC-signed under `SESSION_SECRET` | Whoever holds one is a member of the workspace for 30 days. |
| Secrets | Worker secrets `SESSION_SECRET` and `GOOGLE_CLIENT_SECRET`; repository secret `CLOUDFLARE_API_TOKEN` | Forge sessions, open sealed tokens, impersonate the OAuth client, deploy anything. |
| The sandbox key | The workspace's `meta` table (`sandbox-key`) | Signs the code tokens sandboxed extensions load their code with. |

## Who might attack, and how

- **Someone on the internet**, with no account. They can reach commonink.app's public paths (`/auth/`, `/sandbox/`, `/assets/`, the settings schema and the site's icons), any Preview (everyone there is the dev user), and any page a member visits.
- **A malicious website a member visits.** It can make the browser send requests to commonink.app or to `localhost:8787` (with cookies, or as the dev user), frame pages that allow it, and open windows.
- **A malicious or compromised extension**, installed from a URL or another catalog. Sandboxed by default. It may also hold whatever permissions the person granted.
- **A malicious note or link.** Text written by an agent, a teammate, a synced calendar event or a pasted page, rendered by the live preview, link cards and embeds.
- **A same-site neighbour.** `v1.commonink.app` is the same site as `commonink.app`, so `SameSite=Lax` cookies don't separate them.
- **Someone who can read the Durable Object's data** (the dashboard's data browser, a backup) but doesn't have the Worker's secrets.
- **The supply chain**: an npm package, a GitHub Action, or a pull request's code in CI.

Out of scope: a member of the workspace. Every address in `ALLOWED_EMAILS`, every Access service token and every agent working for a member can read and change everything, as the person can, including which extensions are trusted. The workspace is one trust domain.

## Trust boundaries and what holds them

### 1. The internet and the Worker: who you are

- **Google sign-in** (`sign-in.ts`, `google.ts`): authorization code flow with `state` and PKCE (S256), both in a signed `__Host-ci_google` cookie that lasts 10 minutes. The ID token comes from Google's token endpoint over TLS, so its signature isn't checked again (OIDC Core 3.1.3.7), but its audience, issuer and `email_verified` are. Only addresses in `ALLOWED_EMAILS` (lowercase, split on commas and spaces) get a session.
- **Sessions** are signed JSON in `__Host-ci_session`: `Secure`, `HttpOnly`, `SameSite=Lax`, host-only, 30 days. Every request checks the address against `ALLOWED_EMAILS` again, so removing someone ends their access at the next deploy. Signing in makes a new session. Sign-out clears the cookie and sends `Clear-Site-Data: "cache", "storage"`, and only a navigation from the app or a typed address (or a same-origin POST) does it. A picture or another site gets a button.
- **`next=`** is read the way a browser reads a `Location` and must stay on this origin.
- **Cloudflare Access** (`auth.ts`): an Access JWT (RS256, checked issuer and audience) signs in a person by email or an agent by service token, when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set. Access's own policy decides who gets one.
- **The dev user** (`DEV_USER`) signs in only on `localhost`, `127.0.0.1`, `[::1]` and `pr-<n>-common-ink-v2.<subdomain>.workers.dev` (`devHost` in `hosts.ts`). Production sets no `DEV_USER`, and `test/levers.test.ts` checks the config says so.
- **Test levers** (`levers.ts`) need `LEVERS=1`, a dev user and a dev host. Without them the page gets no inspector, `/api/levers/*` answers 404, and the replay cookie does nothing (`levers-off.browser.ts`).
- **Every route but the public ones** needs an identity. The public ones are `/auth/*`, `/sandbox/*`, `/assets/*` (built scripts and styles), `/schema/settings.json`, and the site's icons and manifest (exact paths in `public-files.ts`).

### 2. Other websites and the workspace: CSRF and framing

- **Origin check** (`index.ts`): any request that changes something (not GET or HEAD) or opens a WebSocket, and comes with an `Origin` that isn't this site's, gets 403, however it's signed in. The dev user is signed in by the address alone, so the cookie isn't what makes this matter. The CLI and agents send no Origin.
- **`SameSite=Lax`** keeps the session cookie off other sites' subresource requests and form posts.
- **`frame-ancestors 'none'`** on the app's pages. The sandbox shells allow only the app's origin.
- **`Cross-Origin-Opener-Policy: same-origin`** on the app's responses, so a window another site opens can't reach the app's.

### 3. The page and what it renders: XSS

- **CSP** (`appCsp` in `sandbox.ts`): `script-src 'self'` with no inline script, `connect-src` only to itself, images and media only from itself, `data:` and `blob:`, `frame-src` only for the sandbox route and the hosts of the link embeds that are on (built-ins and trusted extensions only, with hostnames checked), `base-uri 'none'`, and `form-action 'self'`.
- **No HTML from strings.** The web app builds every element with `createElement` and `textContent`. The only `innerHTML` sets fixed icon SVG. KaTeX runs with `trust: false`. Links open only `http(s):` and `/uploads/`.
- **What counts as same-origin script** is kept small. Uploads are served as the type their name gives, with `nosniff`, a sandboxing CSP, and `attachment` for anything that isn't a picture, audio, video, PDF or plain text. `/extensions/<id>/*.js` answers only for trusted extensions. JSON from `/api/` is `application/json` with `nosniff`.
- **HSTS** (`max-age=31536000`) on every app response.

### 4. Sandboxed extensions and the app (ADR 0006)

- **The frame**: `sandbox="allow-scripts"`, so its origin is opaque, with no cookies, no storage and no access to the parent. The shells (`/sandbox/host`, `/sandbox/webview`) also send CSP `sandbox allow-scripts` and `frame-ancestors <the app>`, so they're opaque wherever they load. They allow `connect-src 'none'`, scripts only from `/sandbox/`, and in a webview inline script.
- **The RPC**: one `MessagePort` per frame, handed over at load. The extension behind a port is fixed by the app, never by the message, so an extension that captures its port can only make calls it could make anyway. Only plain data crosses it (`plainValue`): a structured clone also keeps `String` objects and the like, which compare unlike the text they turn into. Paths are parsed with `parseFilePath` at the dispatcher, before anything checks them.
- **The broker** (`broker.ts`, `permissions.ts`): an undeclared permission is never granted. Declared ones are asked for at the moment of use and the answers are kept in your settings. File scopes are globs over paths that `parseFilePath` has already refused if they hold `..`, `.`, empty segments, backslashes or control characters.
- **The files that decide trust** are `.common-ink/settings.json`, each person's `settings.json` and everything under `.common-ink/extensions/`. A sandboxed extension can never write them, whatever it was allowed (`decidesTrust`). Otherwise `files:write` on `**` would let it trust itself. The Worker checks again: a change to one of them in the name of an extension that isn't trusted (`X-Common-Ink-Extension`) answers 403, except that extension's own `state.json`.
- **Trust belongs to code, not to an id.** Installing from a URL takes the id out of every `extensions.trusted` list, so new code under an old id starts sandboxed.
- **Code tokens**: a sandboxed extension's code comes from `/sandbox/code/<token>/…`, where the token is an HMAC over its id and an expiry (12 hours) under the workspace's sandbox key. Only `.js` files in that extension's folder are served.
- **Navigation**: the app's `frame-src` stops a frame from leaving the sandbox route, and the app stops an extension whose frame tries.

### 5. The Worker and the internet: the safe fetch (`safe-fetch.ts`)

Brokered `net.fetch`, link cards, installs from a URL and other catalogs all go through it:

- `http(s)` only, no credentials in the URL, no `Cookie`, `Authorization`, `Proxy-*`, `Host` or `Referer` from the caller.
- No local names (`localhost`, `*.local`, single labels, with or without a trailing dot), and no private, loopback, link-local, shared, multicast or reserved addresses: IPv4 in any spelling the URL parser accepts, and IPv6 including IPv4 inside it (mapped, compatible, SIIT, NAT64, 6to4), Teredo, site-local, discard and documentation ranges.
- The name is resolved over DNS-over-HTTPS first and refused if any address is private.
- Redirects are followed by hand, at most 3, each checked again. Only browser-safe headers follow a redirect to another origin.
- 8 seconds and 1 MB at most by default (64 KB for a manifest, 256 KB for a catalog, 512 KB for a link card's page, 400 KB for its picture).
- A brokered fetch checks the manifest and your kept answers again on the Worker. "Allow once" is the page's word (ADR 0006).

### 6. Data at rest and secrets

- Refresh tokens are sealed with AES-GCM under an HKDF key from `SESSION_SECRET`. They're opened only to ask Google for an access token, and revoked at Google when you disconnect. Access tokens live in memory for their hour.
- Secrets reach the Worker only from repository secrets at deploy (`--secrets-file`), never from the config. No token is sent to a page or logged: the Worker doesn't log, and errors shown to people name what failed, not the secret.
- The Google scopes are the least the features need: `openid email profile` to sign in, plus `calendar.events`, `calendar.calendarlist.readonly` and `contacts.readonly` when you connect data.

### 7. Supply chain and CI

- `npm audit --audit-level=high` fails CI. Dependabot updates npm packages and Actions weekly.
- Every Action is pinned to a commit. The workflow token is `contents: read` unless a job asks for more. Previews and their credentials run only for pull requests from this repository, never forks or Dependabot.
- gitleaks scans every commit.

## Residual risks

What's known and not fixed, with why.

| Severity | Risk | Why it stays, or what would fix it |
| --- | --- | --- |
| Medium | **Previews are open to everyone as the dev user.** Whatever a Preview can do, anyone on the internet can do there, its brokered fetches included. | Previews hold only sample data. Putting Cloudflare Access in front of Previews, or keeping their network to recordings, would close it. A product decision. |
| Medium | **One OAuth client for v1 and v2.** A leaked `GOOGLE_CLIENT_SECRET` from either Worker serves both. | A client per app would separate them, at the cost of a second consent screen setup. |
| Low | **Stateless sessions.** A stolen session cookie works until it expires (30 days) or `SESSION_SECRET` rotates. Rotating also unseals no refresh tokens, so everyone reconnects Google. | A session table in the Durable Object, as v1 keeps in D1, would allow signing out one session. |
| Low | **DNS rebinding.** The safe fetch resolves a name, then `fetch` resolves it again. A Worker can't pin the address. | Cloudflare's network can't reach private ranges, so this matters only for `npm run dev`. |
| Low | **Trusted extensions are trusted.** They run in the page, can call `/api/` directly and get around the broker (ADR 0006). Anyone who can write settings (members, agents) can trust one. | By design. The trust prompt says so. |
| Low | **Exfiltration from the page.** CSP blocks connections and images to other sites, but script running in the page can still carry data out, by navigating, or through the Worker's own fetches for the page. | No CSP stops top-level navigation. This only matters after script injection, which nothing known allows. |
| Low | **`commands.run`** lets a sandboxed extension run any app command without asking, such as Sign out or Connect Google (which still needs you at Google). | Commands change only the UI, but a permission or an allow-list would make this explicit. |
| Low | **An open live socket outlives its address's removal** from `ALLOWED_EMAILS` until it reconnects. It hears change notices (path, revision, author), not content: every read is checked again. | Tag each socket with how it signed in and close those whose address has gone. |
| Low | **Request URLs in logs.** Workers observability keeps request URLs, which include note paths and the user settings path (an email address). | Turn off invocation logs, or keep paths out of query strings. |
| Low | **Limits that only the platform sets.** JSON bodies, uploads without a `Content-Length`, the number of live sockets, and how often `/api/sync` may run are bounded by Workers' own limits, not the app's. | Only members can reach them. |
| Low | **No `Permissions-Policy`.** v1 sends one. | Add one that turns off camera, microphone, geolocation and the like. |

## Changing something here

- A new route: decide whether it's public. If it is, add it to the list above and keep it exact. If it changes state, it's behind the Origin check already. Keep it that way.
- A new place that renders text: `textContent`, never HTML. A new embed host: it goes in an extension's `frameHosts`, which only built-ins and trusted extensions can add to `frame-src`.
- A new permission kind or a new API for extensions: check it in the broker, and add a hostile case to `test/browser/sandbox.browser.ts` or `sandbox-escape.browser.ts`.
- Anything that fetches a URL someone else chose: `safeFetch`, never `fetch`.
