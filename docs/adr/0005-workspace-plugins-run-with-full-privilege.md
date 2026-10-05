# Workspace plugins run with full privilege

Superseded by ADR 0006: workspace extensions run sandboxed unless you trust them.

A workspace plugin's `index.js` runs in the page like the app's own code: it can read and write every file, call any API as the signed-in person, and change the page. There's no sandbox (an iframe or worker with a message protocol). A workspace has one person in it today, and a plugin is code they or their agent put there, visible in history like any change, so the trust boundary is the workspace itself. A sandbox would mean a second, asynchronous plugin API, and every built-in would have to move to it too to keep ADR 0004 true.

The script is served from the Worker's own origin, so `script-src 'self'` still holds and no inline or third-party script runs. Safe mode (`?safe=1`) starts only built-ins, for recovering from a plugin that breaks the app.

Revisit before workspaces are shared or plugins can be installed from others: then a plugin is someone else's code running as you, and it needs a sandbox and permissions.
