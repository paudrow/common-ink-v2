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

Pushes to `main` deploy to `common-ink-v2.<subdomain>.workers.dev`, and each pull request gets a Preview at `pr-<n>-common-ink-v2.<subdomain>.workers.dev`. Both need, in the repository's settings:

- the secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and the variable `CLOUDFLARE_ACCOUNT_ID`;
- the variables `ACCESS_TEAM_DOMAIN` (like `example.cloudflareaccess.com`), `ACCESS_AUD` and `PREVIEW_ACCESS_AUD`, from Cloudflare Access.

To get the Access values, open the Worker in the Cloudflare dashboard, go to **Settings > Domains & Routes**, and choose **Enable Cloudflare Access** for both `workers.dev` and Preview URLs. Each one's **Manage Cloudflare Access** page shows its application's audience (AUD) tag. Until the variables are set, the Worker answers every request with 401.
