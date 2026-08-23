# Assistant embed surfaces

Static, dependency-free assets served from one CloudFront distribution:

| File | Served at | Purpose |
|---|---|---|
| `widget.js` | `widget.makerbay.app/widget.js` | Loader an SMB pastes into their site; injects a bubble + cross-origin iframe |
| `index.html` + `chat.js` + `chat.css` | `chat.makerbay.app/embed?key=…` | Chat UI inside the widget iframe |
| same | `chat.makerbay.app/{slug}` | Standalone hosted chat page |

Both call the unauthenticated `/v1/public/assistant/*` API, identifying the
tenant by publishable key (`mb_pk_…`) or workspace slug. Spend stays bounded
by the tenant's plan message limit.

No build step — `build.mjs` copies `src/` to `dist/`.
