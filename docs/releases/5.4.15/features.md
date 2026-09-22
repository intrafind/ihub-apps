# Features — 5.4.15

## Admin Config Backup Restore No Longer Risks Wiping the Configuration

Fixed a data-loss risk in **Admin → Backup → Import**: if the safety backup of the current
configuration failed partway through (for example due to a full disk), the import used to proceed
anyway and delete the live configuration directory before copying in the new one.

- The import now stages the imported configuration next to the live one and swaps it in with an
  atomic rename, so there is no window where a request could see a half-restored configuration.
- If the safety backup can't be created, or the final swap fails, the import aborts and the
  original configuration (apps, models, users, groups, encryption key) is left untouched or rolled
  back automatically — nothing is deleted unless the new configuration is safely in place.
- No admin action is required — the fix takes effect automatically on upgrade.

## Brute-Force Rate Limiting Now Actually Applies to Login and Inference Endpoints

Fixed a bug where the rate limiters intended to protect authentication and inference endpoints
were mounted on paths that never matched any real request, so they never fired.

- `POST /api/auth/local/login` (and the LDAP/NTLM login endpoints) are now correctly limited to
  50 requests per 15 minutes per IP, restoring brute-force login protection.
- The OpenAI-compatible inference proxy (`/api/inference/...`) is now correctly rate-limited,
  protecting upstream LLM quota and cost from runaway clients.
- No configuration changes are required; existing `rateLimit.authApi` / `rateLimit.inferenceApi`
  overrides in `platform.json` now take effect as intended.

## Admin Details Popups Are Now Keyboard-Accessible and Consistent

The App, Model, Prompt, and Short Link details popups in the admin area now share one dialog
component, fixing an inconsistency where only the Prompt popup closed on **Escape**.

- All four popups now close on **Escape** and trap keyboard focus while open (Tab/Shift+Tab cycle
  within the dialog instead of escaping to the page behind it), and are marked `aria-modal` for
  screen readers.
- Clicking the dimmed backdrop now also closes the popup, matching other dialogs in the admin area.
- No admin action is required — the fix takes effect automatically on upgrade.

## Admin Save/Load Errors Now Show the Real Reason

Admin pages (Apps, Prompts, Models, Tools, Workflows, Skills, Users, Groups, Agents, Providers,
and more) now display the server's actual error message — a validation problem, a duplicate ID, a
conflict reason — instead of a generic "Request failed with status code 409".

- A shared helper extracts the server-provided error detail everywhere an admin API call fails,
  across roughly 60 call sites.
- Saving an app or prompt that fails validation no longer replaces the entire edit form with a
  full-page error, discarding the in-progress edit — the error now shows as a banner above the
  still-visible form. The same fix applies to the User and Group editors.
- No admin action is required.

## Chat Messages Are Now Sanitized Before Rendering as HTML

User messages that carry an image, file, or audio attachment (or that merely contain text
resembling an `<img>` tag or a `data:image` value) are now sanitized before being rendered as
HTML. Previously this render path skipped the sanitization applied everywhere else in the app, so
a pasted message body could execute arbitrary script in the app's origin.

- No admin action is required — the fix takes effect automatically on upgrade.
- Legitimate attachments (pasted images, uploaded files, audio) continue to render exactly as
  before.

## Dynamic JSX Pages No Longer Depend on a Public CDN

Custom React pages (`contents/pages/*.jsx`) and app-embedded React components now compile using the
JSX compiler already bundled with iHub, instead of fetching it from `unpkg.com`/`cdn.jsdelivr.net`
at runtime. This removes a supply-chain dependency on those CDNs being reachable and trustworthy,
and fixes JSX pages failing to render on air-gapped or self-hosted deployments that block outbound
calls to public CDNs.

- No admin action is required — the compiler now loads from iHub's own bundle on first use.

## Disabling a Teams SSO User Now Actually Blocks Them

Disabling a Microsoft Teams user's account previously had no effect: Teams SSO logins (both the
silent tab/app sign-in and the token-exchange endpoint) never checked or recorded the account's
active status, unlike every other external login method (OIDC, LDAP, NTLM, proxy).

- Teams users are now persisted to `users.json` and validated on every sign-in the same way as
  OIDC/LDAP/NTLM/proxy users, so an admin who disables a Teams user's account blocks them from
  signing in again (`403 Forbidden`).
- No admin action is required — existing Teams users are picked up automatically on their next
  sign-in.

## Cancelling an Agent Run Now Actually Stops It

Cancelling a workflow/agent run, or hitting its per-node timeout, previously only stopped things
*between* steps — an agent step already in progress kept calling the model and running tools in
the background until it finished on its own, even though the run showed as cancelled.

- Cancelling a run (or a timeout firing) now interrupts an in-flight agent step immediately: the
  in-progress model request is aborted, and the agent stops before starting another model call or
  another queued tool call in the same turn.
- This stops wasted LLM spend and background tool activity on runs operators already considered
  stopped.
- Also fixed a related bug where a tool-enabled agent step could fail outright with an internal
  error when native web search was configured, instead of running normally.
- No admin action is required — the fix takes effect automatically on upgrade.

## Web Content Extraction Is Now Protected Against Redirect-Based SSRF

The **webContentExtractor** tool (used directly by apps and internally by Brave Search's page
extraction) validated only the initial URL before fetching. A page that redirected to an internal
address — for example a cloud metadata endpoint — could bypass that check entirely and have the
server fetch it on the tool's behalf.

- Every redirect hop is now re-validated against the same private/internal-address guard as the
  initial request, and the connection is pinned to the validated address to close a DNS-rebinding
  window between the check and the fetch.
- Redirect chains are capped at 5 hops to prevent an unbounded chain.
- No admin action is required — the fix takes effect automatically on upgrade.

## Production Docker Compose Now Boots on a Fresh Clone

`docker/docker-compose.prod.yml` previously couldn't start on a clean checkout, and broke
configuration migrations and admin-UI saves once it did.

- Configuration was bind-mounted from a host `../contents/` folder that doesn't exist until the
  app generates it on first boot, so a fresh clone started with an empty, broken config.
- `contents/config` was mounted read-only, so config migrations and any admin-UI save (platform
  settings, apps, models, etc.) failed once the container did start.
- Replaced the multi-volume, read-only setup with a single writable volume covering the whole
  `contents/` tree, matching how the app already manages its own data — no separate init
  container needed.
- No admin action is required for new deployments. Existing deployments upgrading their compose
  file should back up their current volumes first (see `docker/DOCKER.md`'s updated backup/migration
  steps) since the old per-directory volumes (`ihub-config`, `ihub-data`, `ihub-uploads`, etc.) are
  replaced by a single `ihub-contents` volume.

## Fixed App Crash Caused by Browser Auto-Translation

Fixed a crash where the entire app would fail to load with a generic "Something went wrong" error
on browsers configured to automatically translate pages (for example, Chrome or Edge on a German,
French, or other non-English system).

- The symptom was an unexpected-error screen showing `NotFoundError: Failed to execute
  'insertBefore' on 'Node'`, often in the browser's own translated wording rather than iHub's.
- It was most visible right after a fresh installation, because a new install starts in English
  and a non-English browser would offer to auto-translate it.
- iHub Apps already ships its own language switcher, so browser translation was both redundant and
  the source of the crash. The application now instructs browsers not to auto-translate its pages;
  users should continue to switch languages using the in-app language selector.
- No admin action is required on upgrade.

## Connect Claude and Other MCP Clients Without Manual OAuth Setup

The MCP gateway can now be activated end-to-end from **Admin → MCP gateway**, and MCP clients such
as Claude (claude.ai custom connectors, Claude Desktop), Cursor, and VS Code can connect through
standard OAuth discovery — including automatic client registration.

- The MCP gateway page now includes an **Authentication** section: one toggle enables the OAuth
  authorization server (previously this had to be edited in `platform.json` by hand, which left
  the gateway unusable), and a second toggle enables **Dynamic client registration (RFC 7591)** so
  MCP clients create their OAuth client automatically at `/api/oauth/register` — no manual client
  setup needed. A warning appears if the gateway is on but OAuth is off.
- New standard discovery endpoints: `/.well-known/oauth-authorization-server` (RFC 8414) and
  `/.well-known/oauth-protected-resource` (RFC 9728). Unauthenticated requests to `/mcp` now
  return the `resource_metadata` challenge that MCP clients use to bootstrap authentication.
- Auto-registered clients are never trusted: users always sign in and consent to the requested
  `mcp:*` scopes, and the clients can be reviewed, restricted, or removed under
  **Admin → OAuth clients**. Registration is rate-limited and capped
  (`oauth.dcr.maxClients`, default 100), and only the authorization-code flow can be registered.
- The consent screen now explains `mcp:*` scopes in plain language, and clients that omit the
  `scope` parameter receive their registered scopes instead of a token the gateway would reject.
- Fixed the MCP gateway settings not saving at all: the platform config endpoint reported success
  while discarding the gateway section, so every toggle on the page reverted on reload.
- To connect Claude: enable the three toggles, then add `https://your-ihub/mcp` under
  **Settings → Connectors → Add custom connector** in Claude.

**Note:** after enabling the OAuth authorization server for the first time, restart the server
once so the OAuth session middleware is mounted.
