# Security Headers and Content Security Policy

**Date:** 2026-10-02
**Status:** Proposal

## Goal

Have iHub send the browser security headers itself, so a default install is protected without a
hand-tuned reverse proxy. That means:

- a Content Security Policy (CSP) that limits where scripts, frames and connections can come
  from;
- HSTS on HTTPS deployments;
- `nosniff` and a sane `Referrer-Policy`;
- frame embedding allowed only where iHub is meant to be embedded.

The CSP is defence in depth: it narrows what a markup or script injection could do, and it
contains mistakes in rendering code before anyone finds them.

## Where we are today

- **No middleware sets any of these headers.**
  - `helmet` is not a dependency.
  - `X-Powered-By: Express` is sent.
  - There is no HSTS, `Referrer-Policy` or `Permissions-Policy` anywhere.
  - `docs/security.md` claims "HSTS headers implemented", which is not true.
- **Pages that already set their own headers:**
  - The MCP Apps sandbox page (`server/routes/mcpAppRoutes.js`) sets a CSP and `nosniff`.
  - The Nextcloud embed page (`server/routes/nextcloudEmbedPages.js`) sets `frame-ancestors`
    and removes `X-Frame-Options`.
  - Express's own error pages send `default-src 'none'`.
- **The docs' sample nginx CSP** (`docs/production-reverse-proxy-guide.md`) uses
  `'unsafe-inline' 'unsafe-eval'` for scripts, and the samples still set the deprecated
  `X-XSS-Protection`.
- **Uploads:** files under `/uploads` (including admin-uploaded SVGs) are served from the app's
  origin with their own content type and no `nosniff`.

### What a strict CSP would break today

| Area | What it does | Where |
| --- | --- | --- |
| SPA `index.html` | Inline base-path detection script; inline font `<style>` | `client/index.html` |
| Server rewrite | Injects `<script>window.__SERVER_BASE_PATH__=…</script>` per base path (cached per base path) | `server/services/pwa/PwaService.js` (`buildIndexHtml`) |
| Auth gate | Build step inlines a large `<script>` and `<style>`; adds a `<style>` at runtime | `client/vite-plugins/vite-plugin-auth-gate.js`, `client/src/auth-gate/auth-gate.js` |
| React pages and custom renderers | `@babel/standalone` plus `new Function` in the browser → needs `'unsafe-eval'` | `client/src/shared/components/ReactComponentRenderer.jsx` |
| JSON schema validation | `ajv.compile` generates code with `new Function` | `client/src/utils/schemaValidation.js` |
| Monaco editor | Loads scripts, CSS, fonts and `blob:` workers from `cdn.jsdelivr.net` | `@monaco-editor/loader` default |
| Styles at runtime | Mermaid SVG `<style>`, Monaco, admin custom CSS, print/export iframes, `style=` attributes kept by DOMPurify | `useMermaidRenderer.js`, `UIConfigContext.jsx`, export utilities |
| Images and media | `data:` and `blob:` images and audio, external favicons and markdown images, admin logo URLs | many |
| Workers and worklets | pdf.js worker (same origin), Monaco `blob:` workers, AudioWorklets from `blob:` | `fileProcessing.js`, `realtimeTranscriptionCore.js` |
| Office add-in pages | Inline scripts, inline `onerror=` handlers, Office.js from Microsoft's CDN (configurable) | `client/office/*.html`, `server/utils/officeJsSource.js` |
| OAuth consent pages | Inline `<style>`; the consent form posts and then redirects to the client's `redirect_uri` (another origin) | `server/routes/oauthAuthorize.js` |

### Where iHub must stay embeddable (`frame-ancestors`)

| Surface | Embedded by |
| --- | --- |
| Microsoft Teams tab (`/teams/tab`, SPA route) | Teams, Outlook and Microsoft 365 hosts (teams-js list of valid domains) |
| Office add-in task pane (`/office/*.html`) | Outlook on the web |
| Nextcloud embed (`/nextcloud/full-embed.html`, then SPA routes) | The configured Nextcloud hosts |
| Generic embedding (`?header=false`, documented in `docs/ui.md`) | Whatever the admin allows |
| MCP Apps sandbox | iHub itself (already `frame-ancestors 'self'`) |

Two consequences:

- A single global `X-Frame-Options: DENY` is not workable; `frame-ancestors` has to be decided per
  route.
- The Nextcloud embed reloads into ordinary SPA routes, so the SPA's own `frame-ancestors` has to
  include the Nextcloud hosts when that integration is on.

## Proposal

The work is split into phases so nothing breaks unannounced. Each phase is its own PR.

### Phase 1: baseline headers (no CSP yet)

Use `helmet`, configured explicitly rather than with its defaults:

| Header | Value | Note |
| --- | --- | --- |
| `X-Powered-By` | removed | `app.disable('x-powered-by')` |
| `X-Content-Type-Options` | `nosniff` | everywhere, including `/uploads` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | answer-source favicons already use `no-referrer` |
| `Strict-Transport-Security` | `max-age=15552000` (180 days), no `preload` | only when the request is HTTPS (`req.secure`, which honours `trustProxy`); configurable; never sent on plain HTTP (`cookieSettings.disableSecure` setups) |
| `X-Frame-Options` | not sent | replaced by `frame-ancestors` in phase 2; until then nothing changes for embedders |
| `Cross-Origin-Resource-Policy` | `cross-origin` | helmet's default `same-origin` would break the browser extension, which loads assets from iHub across origins |
| `Cross-Origin-Opener-Policy` | not sent | Teams and Nextcloud sign-in popups rely on `window.opener` |
| `Cross-Origin-Embedder-Policy` | not sent | |
| `X-XSS-Protection` | `0` | helmet default; the old filter is unsafe |
| `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `X-Permitted-Cross-Domain-Policies` | helmet defaults | harmless |

Uploaded files (`/uploads`, Jira image attachments, source provider content shown inline) get a
restrictive CSP of their own: `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline';
sandbox`. They then render as images or documents only, even when opened directly. SVG stays
allowed as a logo or icon format.

Also in this phase:

- Correct `docs/security.md` and the sample nginx configurations:
  - drop `X-XSS-Protection` and the `'unsafe-eval'` sample;
  - explain that iHub sends these headers itself, and that a proxy should not add them a second
    time.
- Fix the nginx sample's `/ai-hub` vs `/ihub` mix-up.

### Phase 2: CSP in report-only mode

Send `Content-Security-Policy-Report-Only` for the SPA document. Add a report endpoint (`POST
/api/csp-report`) that is rate-limited, size-limited, unauthenticated and logs aggregated
reports. Real deployments then show what would break before anything is enforced.

Proposed policy for `index.html`:

```text
default-src 'self';
script-src 'self' 'sha256-…' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
media-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' <configured speech endpoints>;
worker-src 'self' blob:;
frame-src 'self' <origins of configured iframe apps>;
frame-ancestors 'self' <Teams hosts when Teams is on> <Nextcloud hosts when the embed is on> <admin list>;
base-uri 'self';
object-src 'none';
form-action 'self';
report-uri /api/csp-report
```

- **Inline scripts get hashes, not `'unsafe-inline'`.** `buildIndexHtml` already produces the
  final document per base path and caches it. It also computes the SHA-256 of every inline
  `<script>` in that document (the base-path script, the auth-gate script) and stores the hash
  list next to the cached HTML. The static route sends those hashes in the CSP. This works with
  the existing cache, needs no nonce, and covers the build-time inlined auth gate.
- **`'unsafe-eval'` stays until phase 3.** It is needed by React pages, custom renderers and ajv.
- **`style-src 'unsafe-inline'` stays.** Mermaid, Monaco, admin custom CSS and the print iframes
  inject styles at runtime, and hashing them is impractical. Inline styles are a much smaller risk
  than inline scripts.
- **`img-src https:`** keeps external favicons, markdown images and admin logo URLs working. A
  stricter list can be an admin option later.
- **`connect-src`** is built from configuration: Azure Speech host and region, and other voice
  endpoints. `'self'` covers same-origin `ws:`/`wss:` in current browsers. The teams-js domain
  list (`res.cdn.office.net`) is added on Teams routes only.
- **`frame-src`** is built from the origins of the configured iframe apps. The cache refreshes
  when apps change.
- **`frame-ancestors`** depends on the route and the configuration: Teams routes get the Teams
  host list, and the Nextcloud and generic-embedding lists come from the platform configuration.
- **Monaco becomes self-hosted** (bundled assets under the app's own path). That removes the
  `cdn.jsdelivr.net` dependency, which also matters for installations without internet access.

Other documents get their own policy:

| Document | Policy |
| --- | --- |
| OAuth authorize and consent pages | `default-src 'none'; style-src 'sha256-…'; form-action 'self' <client redirect origin>; frame-ancestors 'none'`. The consent form's POST ends in a redirect to the client, which `form-action` covers in some browsers. |
| Office add-in pages | Hashes for the inline scripts, with the inline `onerror=` handlers moved into script. `script-src` adds the configured Office.js origin; `frame-ancestors` lists the Outlook hosts. |
| Nextcloud embed, MCP sandbox | Keep their current headers. The global middleware must not overwrite them (they already call `setHeader`, which replaces). |
| Swagger UI (`/api/docs`), mdBook (`/docs`) | A relaxed policy of their own (inline styles and scripts), still with `frame-ancestors 'self'` |

### Phase 3: enforce, and remove `'unsafe-eval'`

- Compile React pages and custom renderers on the server when they are saved or loaded:
  - `@babel/core` on the server produces a module served from the app's own origin, which the
    client loads with `import()`;
  - the client no longer needs `@babel/standalone` or `new Function`;
  - this also makes those pages load faster.
- Replace client-side `ajv.compile` with precompiled validators or a validator that doesn't
  generate code.
- Switch from report-only to enforced. Admins keep a switch to go back to report-only.

## Configuration

A new `security` section in `platform.json`, with a migration that adds the defaults:

```json
{
  "security": {
    "headers": {
      "enabled": true,
      "hsts": { "enabled": true, "maxAgeSeconds": 15552000, "includeSubDomains": false },
      "csp": {
        "mode": "report-only",
        "frameAncestors": [],
        "extraSources": { "img-src": [], "connect-src": [], "frame-src": [] }
      }
    }
  }
}
```

- `csp.mode` is one of `off`, `report-only` or `enforce`. The default is `report-only` in
  phase 2 and `enforce` in phase 3.
- `frameAncestors` is the admin list for generic embedding. The Teams and Nextcloud entries are
  added automatically from their integrations.
- Environment overrides: `SECURITY_HEADERS_ENABLED` and `CSP_MODE`, for installations behind a
  proxy that manages headers itself.
- Admin UI: a small section under **Admin → System** showing the effective policy and the latest
  reports.

## Testing

- **Server:**
  - every header is present with the expected value;
  - HSTS is sent only over HTTPS;
  - the per-route `frame-ancestors` are correct;
  - the hash list matches the inline scripts of the built `index.html` at root and under a
    subpath;
  - Nextcloud and MCP pages keep their own policy.
- **E2E:** Playwright runs with `enforce` and fails on any CSP violation in the console. It
  covers:
  - sign-in through the auth gate;
  - chat with Mermaid;
  - a React page and a custom renderer;
  - an iframe app;
  - the Monaco editor in admin;
  - voice input;
  - printing;
  - the Office task pane;
  - a subpath deployment.

## Open questions

- Should HSTS default to on for every HTTPS request, or only when an admin confirms that all
  subdomains or proxies serve HTTPS?
- How much should `img-src` be limited by default? `https:` keeps today's behaviour.
- Generic embedding: default to `'self'` only (a breaking change for anyone embedding iHub in an
  intranet portal), or start from a permissive value with a warning in the admin?
- Do we keep a supported way to run React pages compiled in the browser for development?
