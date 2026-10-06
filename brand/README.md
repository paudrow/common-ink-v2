# Common Ink brand

These files are copied from Common Ink v1 (paudrow/commonink at 6debe796), where `npm run brand` ([scripts/brand.ts](https://github.com/paudrow/commonink/blob/6debe796/scripts/brand.ts)) generates them with `sharp`. v2 keeps the generated files, not the script, so its installs don't carry `sharp`. To change the drop or its colour, bring that script over with `sharp` as a dev dependency and run it here.

| File | Use it for |
|---|---|
| `logo.svg` | The logo anywhere a vector works (docs, slides, the web) |
| `png/logo-120.png` | Google OAuth consent screen (Google Auth Platform → Branding) |
| `png/logo-1024.png` | Large uses: app directories, Slack/Discord app icons, press |
| `png/logo-square-1024.png` | Places that round the corners themselves (App Store, some avatars) |
| `png/logo-{16…512}.png` | Anything that asks for a specific size |
| `mark.svg`, `png/mark-*.png` | The drop alone, in indigo, for light backgrounds |
| `social.png` | Link previews (1200×630); also served at `/social.png` |

Colour: a white drop on an indigo `#5b5bd6` tile; the link preview sits on paper `#fbfaf8`. The site's own icons (favicon, home-screen icons) and its manifest are in `web/public/`, served at the site root without sign-in (worker/src/public-files.ts).
