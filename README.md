# common-ink-v2

A minimal, keyboard-first workspace for markdown notes, tasks and calendar data, built for both people and agents.

- [PRINCIPLES.md](PRINCIPLES.md): the rules every feature has to follow
- [ROADMAP.md](ROADMAP.md): what's being built, in order (edited by hand)
- [CONTEXT.md](CONTEXT.md): the project's vocabulary
- [docs/adr/](docs/adr/): architectural decisions and why they were made
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

Pushes to `main` deploy to `common-ink-v2.<subdomain>.workers.dev`, behind Cloudflare Access. Each pull request gets a Preview at `pr-<n>-common-ink-v2.<subdomain>.workers.dev` that opens signed in as a dev user, with its own sample notes. Both need, in the repository's settings, the secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and the variable `CLOUDFLARE_ACCOUNT_ID`. Production also needs the variables `ACCESS_TEAM_DOMAIN` (like `example.cloudflareaccess.com`) and `ACCESS_AUD`.

Uploads are kept in R2: production in the bucket `common-ink-v2-uploads`, every Preview in `common-ink-v2-uploads-preview`. CI makes each bucket if it's missing (`scripts/ensure-bucket.sh`), which needs the token to have **Workers R2 Storage: Edit** too. Otherwise make them once with `npx wrangler r2 bucket create common-ink-v2-uploads` and `npx wrangler r2 bucket create common-ink-v2-uploads-preview`. `npm run dev` keeps uploads on disk.

To get the Access values, open the Worker in the Cloudflare dashboard, go to **Settings > Domains & Routes**, and choose **Enable Cloudflare Access** for `workers.dev` only. Its **Manage Cloudflare Access** page shows the application's audience (AUD) tag. Until the variables are set, production answers every request with 401.

## Agents: CLI and MCP

Agents use the same operations as the app: list, read, write and delete files, read history, undo, and upload.

- **CLI.** `bin/common-ink ls | cat <path> | write <path> | rm <path> | upload <file> | history [path] | show <revision> | undo <revision...>` (`npm link` puts `common-ink` on your PATH). It talks to `COMMON_INK_URL` (default `http://localhost:8787`) as the agent named in `COMMON_INK_AGENT` (default `CLI`). Behind Access, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` to an Access service token.
- **MCP.** `<workspace URL>/mcp` is an MCP server over HTTP. Add `?agent=<name>` to name the agent in history. Its tools are the workspace operations (`worker/src/operations.ts`): `list_files`, `read_file`, `write_file`, `delete_file`, `history`, `undo`, `diff`, `read_version`, `restore`, labels, data sources, `list_uploads` and `upload_file`.

## Google sign-in, calendar and contacts

People sign in with Google, and only addresses in `ALLOWED_EMAILS` get in. Cloudflare Access still works too, for anyone it lets through and for agents with an Access service token. To turn Google sign-in on:

1. In Google Cloud, create an OAuth client (Web application). Add `https://common-ink-v2.<subdomain>.workers.dev/auth/google/callback` as an authorized redirect URI, and enable the Google Calendar API and the People API. While the OAuth consent screen is in testing, add yourself as a test user.
2. In the repository's settings, set the variables `GOOGLE_CLIENT_ID` and `ALLOWED_EMAILS` (addresses separated by commas), and the secrets `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` (any long random string, such as the output of `openssl rand -base64 32`). The next deploy sends them to the Worker.
3. In the app, run "Connect Google calendar and contacts" (⌘⇧P) to give it read access to both.

Previews and `npm run dev` use recorded sample data (`worker/src/fixtures/`) instead of Google, and open signed in as a dev user.
