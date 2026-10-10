# common-ink-v2

A minimal, keyboard-first workspace for markdown notes, tasks and calendar data, built for both people and agents.

- [PRINCIPLES.md](PRINCIPLES.md): the rules every feature has to follow
- [ROADMAP.md](ROADMAP.md): what's being built, in order (edited by hand)
- [CONTEXT.md](CONTEXT.md): the project's vocabulary
- [docs/adr/](docs/adr/): architectural decisions and why they were made
- [docs/security.md](docs/security.md): the threat model (what's protected, from whom, and how), what's still open, and how to report a vulnerability
- [docs/TESTING.md](docs/TESTING.md): how people and agents test, locally and on Previews: scenarios, test levers, the inspector, the probe CLI, and regression tests

## Develop

```sh
npm install
npm run dev                       # http://localhost:8787, signed in as dev@localhost, with the Preview's sample notes
npm run dev -- --scenario lists   # or seeded from a scenario in test/scenarios/
npm run check                     # typecheck, tests and build: run before every push
npm run test:browser              # the app in headless Chrome against the real Worker
npm run probe -- --scenario lists --open "Lists tour" --keys "jj>>" --dump cursor
```

[docs/TESTING.md](docs/TESTING.md) says how to drive the app with test levers, from a test, the probe CLI or `window.__commonInk`.

The Worker is in `worker/`, the web app in `web/`. Each pull request adds `examples/preview/<slug>.json` (`{"pr": 12, "title": "...", "steps": ["..."]}`) and any sample notes it needs in `examples/preview/<slug>/`; its Preview starts with them and a "Try this PR" note.

## Deploy

Pushes to `main` deploy to **v2.commonink.app**, where people sign in with Google (below); its MCP endpoint is `v2.commonink.app/mcp`. `commonink.app` belongs to Common Ink v3, and v1 runs on at `v1.commonink.app`. While this Worker also answers on `commonink.app`, it redirects `www.commonink.app` there and sends links kept from v1 (shared links, invites, meeting notes, its docs) on to v1 (`worker/src/hosts.ts`). Each pull request gets a Preview at `pr-<n>-common-ink-v2.<subdomain>.workers.dev` that opens signed in as a dev user, with its own sample notes. Production has no `workers.dev` address.

Both need, in the repository's settings, the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`. The token needs **Workers Scripts: Edit** for the account and **Workers Routes: Edit** for the commonink.app zone, which deploying the custom domain takes.

A custom domain belongs to one Worker at a time, and a deploy that names a domain takes it from whichever Worker has it. `npm run deploy` names only `v2.commonink.app`; never add `commonink.app` back, or this Worker takes the domain from v3. (`scripts/cutover-wizard.sh` is the historic walk-through of the old v1 to v2 move, kept for reference only.)

Uploads are kept in R2: production in the bucket `common-ink-v2-uploads`, every Preview in `common-ink-v2-uploads-preview`. CI makes each bucket if it's missing (`scripts/ensure-bucket.sh`), which needs the token to have **Workers R2 Storage: Edit** too. Otherwise make them once with `npx wrangler r2 bucket create common-ink-v2-uploads` and `npx wrangler r2 bucket create common-ink-v2-uploads-preview`. `npm run dev` keeps uploads on disk.

**Cloudflare Access is optional now.** People sign in with Google. The Worker still accepts an Access token when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, which is how an agent reaches production: put an Access application on `v2.commonink.app/mcp` only, with a Service Auth policy, and give the agent a service token. Leave the rest of the site out of it, or people would sign in twice. Until the variables are set, only Google sign-in works.

## Agents: CLI and MCP

Agents use the same operations as the app: list, read, write and delete files, read history, undo, and upload.

- **CLI.** `bin/common-ink ls | cat <path> | write <path> | rm <path> | upload <file> | history [path] | show <revision> | undo <revision...>`, and for the calendar `calendars | events | event <address> | event add | event set | event rm | event link` (`npm link` puts `common-ink` on your PATH). It talks to `COMMON_INK_URL` (default `http://localhost:8787`) as the agent named in `COMMON_INK_AGENT` (default `CLI`). Behind Access, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` to an Access service token. Production's `/api/` isn't behind Access, so the CLI reaches only local servers and Previews for now.
- **MCP.** `<workspace URL>/mcp` is an MCP server over HTTP. Add `?agent=<name>` to name the agent in history. Its tools are the workspace operations (`worker/src/operations.ts`): `list_files`, `read_file`, `write_file`, `delete_file`, `history`, `undo`, `diff`, `read_version`, `restore`, labels, `list_uploads` and `upload_file`, and for data sources `data_sources`, `list_calendars`, `list_events`, `read_event`, `create_event`, `update_event`, `delete_event`, `link_event` and `list_contacts`.

Calendar events are records of a data source, not notes (ADR 0007): each is a JSON file under `.common-ink/records/` with its own history, changed only through the event operations, which send the change on to Google.

## Google sign-in, calendar and contacts

People sign in with Google, and only addresses in `ALLOWED_EMAILS` get in. Common Ink v2 shares v1's OAuth client, so one Google Cloud project serves both. `scripts/cutover-wizard.sh` once set this up (historic); by hand:

1. In Google Cloud, use the OAuth client (Web application) with `https://v2.commonink.app/auth/google/callback` as an authorized redirect URI, and enable the Google Calendar API and the People API. The consent screen asks for `calendar.events` (read and change events on calendars you can see), `calendar.calendarlist.readonly` (list those calendars and their colours) and `contacts.readonly`. While it's in testing, add each person as a test user. Google ends a test app's access after 7 days; connect again then.
2. In the repository's settings, set the variables `GOOGLE_CLIENT_ID` and `ALLOWED_EMAILS` (addresses separated by commas), and the secrets `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` (any long random string, such as the output of `openssl rand -base64 32`). The next deploy sends them to the Worker. `SESSION_SECRET` signs sessions and seals Google's refresh tokens, so changing it signs everyone out and asks for Google to be connected again; edits waiting for Google are kept until it is.
3. In the app, run "Connect Google calendar and contacts" (⌘⇧P).

The calendar syncs every 10 minutes and whenever it's shown, one sync token per calendar. Edits go to Google straight away; one Google can't take yet waits, and the Data sources view says why. When Google ends the grant, the status bar and the calendar say "Reconnect Google Calendar", one click goes to Google and back to where you were, and what waited goes out then.

Previews and `npm run dev` use recorded sample data (`worker/src/fixtures/`) instead of Google, and open signed in as a dev user.
