# common-ink-v2

A minimal, keyboard-first workspace for markdown notes, todos and calendar data, built for both people and agents.

- [PRINCIPLES.md](PRINCIPLES.md): the rules every feature has to follow
- [ROADMAP.md](ROADMAP.md): what's being built, in order (edited by hand)
- [CONTEXT.md](CONTEXT.md): the project's vocabulary
- [docs/adr/](docs/adr/): architectural decisions and why they were made

## Develop

```sh
npm install
npm run dev     # http://localhost:8787, signed in as dev@localhost, with the Preview's sample notes
npm run check   # typecheck, tests and build: run before every push
```

The Worker is in `worker/`, the web app in `web/`. Each pull request adds `examples/preview/<slug>.json` (`{"pr": 12, "title": "...", "steps": ["..."]}`) and any sample notes it needs in `examples/preview/<slug>/`; its Preview starts with them and a "Try this PR" note.

## Deploy

Pushes to `main` deploy to `common-ink-v2.<subdomain>.workers.dev`, behind Cloudflare Access. Each pull request gets a Preview at `pr-<n>-common-ink-v2.<subdomain>.workers.dev` that opens signed in as a dev user, with its own sample notes. Both need, in the repository's settings, the secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and the variable `CLOUDFLARE_ACCOUNT_ID`. Production also needs the variables `ACCESS_TEAM_DOMAIN` (like `example.cloudflareaccess.com`) and `ACCESS_AUD`.

To get the Access values, open the Worker in the Cloudflare dashboard, go to **Settings > Domains & Routes**, and choose **Enable Cloudflare Access** for `workers.dev` only. Its **Manage Cloudflare Access** page shows the application's audience (AUD) tag. Until the variables are set, production answers every request with 401.

## Agents: CLI and MCP

Agents use the same operations as the app: list, read and write docs, read history, undo.

- **CLI.** `bin/common-ink ls | cat <path> | write <path> | history [path] | show <revision> | undo <revision...>` (`npm link` puts `common-ink` on your PATH). It talks to `COMMON_INK_URL` (default `http://localhost:8787`) as the agent named in `COMMON_INK_AGENT` (default `CLI`). Behind Access, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` to an Access service token.
- **MCP.** `<workspace URL>/mcp` is an MCP server over HTTP. Add `?agent=<name>` to name the agent in history. Its tools are `list_docs`, `read_doc`, `write_doc`, `history` and `undo`.
