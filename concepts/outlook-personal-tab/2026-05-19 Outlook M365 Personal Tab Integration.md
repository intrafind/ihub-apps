# Outlook M365 Personal Tab Integration — design

## Problem

Users in our pilot tenants already have the iHub Outlook task-pane
add-in for per-email assistance, but they have asked for the **full
iHub UI** — app catalogue, magic prompt, sources, model picker — to
be reachable directly from Outlook without leaving the window. In the
new Outlook, Microsoft Teams, and Microsoft 365 Copilot, third-party
apps appear as icons on the left **app rail** alongside Mail, Calendar
and To Do. We want iHub to live there too.

The natural reference is the Nextcloud embed we shipped for issue
[#1401](https://github.com/intrafind/ihub-apps/issues/1401): iHub
loaded inside a host's chrome via an iframe, with admin-controlled
parent origins and PKCE OAuth. The Microsoft 365 surface is the
third host after Nextcloud and the browser extension.

## Constraints

- **Reuse, don't rebuild.** The Nextcloud embed already established
  the pattern — admin-toggle that auto-creates a public PKCE OAuth
  client, embed page with dynamic `Content-Security-Policy:
  frame-ancestors`, `allowedHostOrigins`, the
  `client/src/features/office/` host-adapter contract. The Outlook
  personal tab is the fourth consumer (after Outlook task pane,
  Nextcloud, browser extension).
- **Coexist with the existing add-in.** The task-pane add-in in
  `server/routes/integrations/officeAddin.js` (XML manifest,
  `<OfficeApp xsi:type="MailApp">`) stays unchanged. The personal tab
  ships as a second, independent manifest.
- **No breaking changes to platform config.** New surface lives under
  a new `outlookPersonalTab` key in `platform.json`. The existing
  `officeIntegration` block is untouched.
- **Defence in depth.** Never trust the host frame. Validate
  `frame-ancestors`, `postMessage` origin, and any token received
  from a TeamsJS bridge with the same strictness as Nextcloud.
- **Classic Win32 Outlook is out of scope.** It has no left-rail app
  surface. Users on classic Outlook keep the task-pane add-in.

## Target hosts

A single unified-manifest package surfaces in all of:

- **New Outlook for Windows / Outlook on the web** — under
  *Apps* / *More apps* on the side bar.
- **Microsoft Teams** desktop and web — as a personal app.
- **Microsoft 365 Copilot** (formerly the Microsoft 365 / Office app)
  — under *Apps* in the side rail.

Out of scope: classic Outlook (Win32 perpetual), Outlook Mobile (no
left-rail apps; only mail add-ins).

## Architecture

```
┌────────────────────────────────────────────────┐
│  M365 host (new Outlook / Teams / M365)        │
│                                                │
│  ┌────────────────────────────────────────┐    │
│  │ App rail icon: "iHub Apps"             │    │
│  └─────────────────┬──────────────────────┘    │
│                    │ opens personal tab        │
│                    ▼                           │
│  ┌────────────────────────────────────────┐    │
│  │ host iframe (Outlook/Teams chrome)     │    │
│  │  loads <ihub>/outlook/full-embed.html  │    │
│  └─────────────────┬──────────────────────┘    │
└────────────────────┼───────────────────────────┘
                     │ (iframe; SameSite=None+Secure cookies)
                     │
┌────────────────────┼───────────────────────────┐
│  iHub (ihub.example.com)                       │
│  /outlook/full-embed.html                      │
│                                                │
│  ┌────────────────────────────────────────┐    │
│  │ @microsoft/teams-js bootstrap          │    │
│  │  app.initialize() → app.getContext()   │    │
│  └─────────────────┬──────────────────────┘    │
│                    ▼                           │
│  ┌────────────────────────────────────────┐    │
│  │ Auth gate                              │    │
│  │  ① NAA / getAuthToken() (preferred)    │    │
│  │  ② PKCE popup fallback                 │    │
│  └─────────────────┬──────────────────────┘    │
│                    ▼                           │
│  ┌────────────────────────────────────────┐    │
│  │ Standard iHub <App /> (unchanged)      │    │
│  └────────────────────────────────────────┘    │
└────────────────────────────────────────────────┘
```

## Manifest

A single Microsoft 365 unified manifest (`manifest.json`, schema
**v1.20**) packaged in a ZIP with the two required icons.

Key entries:

```jsonc
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.20/MicrosoftTeams.schema.json",
  "manifestVersion": "1.20",
  "id": "<new GUID, distinct from the task-pane add-in GUID>",
  "version": "1.0.0",
  "developer": { "name": "intrafind", "websiteUrl": "https://<ihub>" },
  "name":      { "short": "iHub Apps", "full": "iHub Apps" },
  "description": { "short": "...", "full": "..." },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#4F46E5",
  "staticTabs": [{
    "entityId": "ihub-home",
    "name":     "iHub Apps",
    "contentUrl": "https://<ihub>/outlook/full-embed.html",
    "websiteUrl": "https://<ihub>/",
    "scopes": ["personal"]
  }],
  "validDomains": ["<ihub>"],
  "webApplicationInfo": {
    "id": "<Entra App (Client) ID>",
    "resource": "api://<ihub>/<Entra App (Client) ID>"
  }
}
```

Generated dynamically — same idea as `officeAddin.js`'s
`/manifest.xml` — so the URLs always match the live deployment.

Notes:

- Only `scopes: ["personal"]` renders outside Teams.
- Use a **new GUID**; do not reuse the task-pane add-in's GUID.
- Manifest version 1.13 is the floor that surfaces in Outlook/M365;
  1.20 is the recommended baseline. Avoid 1.16 (changed prior
  static-tab defaults). Re-test on each schema bump.

## Server changes

| Path | Purpose |
| --- | --- |
| `server/migrations/V040__add_outlook_personal_tab_config.js` | Default `outlookPersonalTab` block in `platform.json` |
| `server/routes/admin/outlookPersonalTab.js` | Admin status / enable / disable / config (mirrors `nextcloudEmbed.js`) |
| `server/routes/integrations/outlookPersonalTab.js` | Public runtime config (`/api/integrations/outlook-personal-tab/config`) and `/manifest.zip` builder |
| `server/routes/outlookPersonalTabPages.js` | Serves `/outlook/full-embed.html` with dynamic CSP `frame-ancestors` |

Re-uses unchanged:

- `server/utils/oauthClientManager.js` — public PKCE client creation.
- `server/utils/platformSecrets.js` — encryption-at-rest.
- The OAuth authorization-code flow itself (the same one the
  task-pane add-in and Nextcloud embed already use).

### CSP `frame-ancestors`

Always-allowed parent origins (in addition to admin-supplied entries):

```
https://*.cloud.microsoft
https://teams.microsoft.com https://*.teams.microsoft.com
https://*.microsoft365.com https://*.office.com
https://outlook.office.com https://outlook.office365.com
https://outlook-sdf.office.com https://outlook-sdf.office365.com
```

`*.cloud.microsoft` is mandatory — Microsoft is migrating M365 hosts
to that unified domain and the iframe will silently fail to load if
it's missing.

### Cookies

Auth session cookies served to the embed need `SameSite=None; Secure`
(third-party iframe context). The existing `cookieSettings` block in
`platform.json` already supports this; production deployments are
fine, local development needs HTTPS or a same-site dev proxy.

## Client changes

| Path | Purpose |
| --- | --- |
| `client/outlook/full-embed.html` | Entry HTML — loads TeamsJS, mounts iHub `<App />` |
| `client/outlook/full-app-entry.jsx` | Bootstrap: TeamsJS init → auth gate → mount the standard iHub `<App />` |
| `client/outlook/outlook.css` | Scoped reset (mirror of `nextcloud.css`) |
| `client/public/outlook/callback.html` | OAuth popup callback for the PKCE-fallback path |
| `client/src/features/outlook-personal-tab/utilities/teamsHostBridge.js` | `microsoftTeams.app.initialize()`, `getContext()`, host detection |
| `client/src/features/outlook-personal-tab/utilities/teamsAuthDialog.js` | Popup-based PKCE fallback when NAA is unavailable |
| `client/src/features/outlook-personal-tab/hooks/useTeamsSso.js` | NAA / `getAuthToken()` orchestration |
| `client/src/features/admin/pages/AdminOutlookPersonalTabPage.jsx` | Admin UI |

The Vite multi-entry config picks up `client/outlook/full-embed.html`
and emits the bundle into `client/dist/outlook/` (mirrors the existing
`client/dist/nextcloud/` build target).

Dependency: `@microsoft/teams-js` **≥ 2.19.0**. Older versions log
deprecation warnings and do not know about the new `*.cloud.microsoft`
hosts.

## Auth model

Two paths, layered:

### ① Preferred — Nested App Authentication (NAA) via MSAL

Microsoft's currently recommended path for new builds. The embed
calls MSAL with an Entra ID public client, requests an iHub-scoped
access token, and receives it silently because the user is already
signed into the host (Entra ID). No popup, no `getAuthToken`/OBO
plumbing, no server-side On-Behalf-Of dance.

Requires the iHub Entra ID app registration to:

- Define an Application ID URI: `api://<ihub-host>/<clientId>`.
- Expose an API scope, e.g. `access_as_user`.
- Pre-authorize the six well-known M365 host client IDs (Teams web,
  Teams desktop, M365 web, M365 desktop, Outlook web, Outlook
  desktop/mobile — listed in the Microsoft Learn SSO doc).

The iHub server then validates the JWT (`aud` = iHub's Application ID
URI) and translates it into iHub's normal session.

NAA only works when iHub auth talks to the **same Entra ID tenant**
the user is signed into. Multi-tenant or non-Entra deployments fall
through to path ②.

### ② Fallback — PKCE popup (Nextcloud-style)

The embed runs the existing iHub OAuth2 + PKCE flow against the
auto-created public client, with redirect URI
`/outlook/callback.html`. The popup variant is required because
redirect-based OAuth is blocked inside the M365 iframe.

This is what the Nextcloud embed already does — same code path, same
`oauthClientManager`, same callback HTML pattern. It works
unconditionally, regardless of which auth provider iHub talks to.

### How the two interact

At runtime the auth gate tries NAA first. If MSAL reports the host
or tenant is not eligible (or the iHub tenant doesn't match), it
falls back to the popup PKCE flow. The user sees one or the other,
never both.

Shipping ② first and adding ① as a follow-up is a viable
phasing — the user-visible behaviour is identical to Nextcloud's
"Sign in" popup, which the team is already comfortable with.

### iOS / mobile

iOS Safari blocks third-party cookies; the embed must therefore not
rely on cookie-only session state. NAA returns a bearer token the
embed stores in memory; the popup PKCE flow stores tokens via the
existing iHub mechanism. Either way, ensure no path depends on
SameSite=None cookies surviving across host navigations.

## Deployment

Mirrors the existing add-in flow:

1. Admin enables `integrations` feature flag.
2. Admin opens **Admin → Outlook Personal Tab** and clicks **Enable**:
   - Auto-creates a public PKCE OAuth client (redirect URI
     `/outlook/callback.html`).
   - Flips `outlookPersonalTab.enabled = true`.
3. Admin customizes display name, description, icons, accent colour.
4. Admin downloads the manifest ZIP from the admin page (or fetches
   `GET /api/integrations/outlook-personal-tab/manifest.zip`).
5. Admin uploads it in **Microsoft 365 Admin Center → Settings →
   Integrated apps → Upload custom apps**.
6. Within 6–24h the app appears under *Apps* / *More apps* on the
   side bar in new Outlook (and in Teams + M365 Copilot for the same
   users).

For pilot/QA: sideload via **Teams → Apps → Manage your apps → Upload
a custom app** (the user's Teams app-permission policy must allow
custom uploads). Sideloaded apps appear automatically on the new
Outlook side bar — no separate Outlook upload needed.

### Admin consent

The Entra ID app registration needs admin consent for the scopes it
exposes. The `access_as_user` scope on iHub's own API is normally
user-consentable in single-tenant deployments. Any Graph scopes added
later for an OBO flow require tenant admin consent.

## Trade-offs

- **Reuse over duplication.** The personal tab is the fourth consumer
  of the `oauthClientManager` + admin enable-toggle + embed-page
  pattern (after task-pane add-in, Nextcloud, browser extension).
  Net new code is small; risk concentrates in the manifest and
  TeamsJS bridge rather than spread across auth/permissioning.
- **NAA over `getAuthToken` + OBO.** Microsoft now points new builds
  at NAA. It removes the server-side OBO complexity that the
  `getAuthToken` path would add. Cost: NAA only helps when iHub auth
  is Entra ID; otherwise we use the popup. We're happy with that —
  the popup is the proven Nextcloud path.
- **Personal tab over Outlook task-pane "full" mode.** We did
  consider just widening the task-pane add-in to host the whole iHub
  UI. Rejected: the task pane only opens *on a selected mail item*
  and is constrained to ~320px width on default. The user explicitly
  wants iHub on the app rail, not on the mail ribbon.
- **Unified manifest over a Teams-only manifest.** Both can land in
  Outlook, but Microsoft is consolidating around the unified
  M365 manifest and the integrated-apps portal. Picking unified now
  avoids a forced migration in a year.
- **No left-rail auto-pin.** The icon lands under *Apps* / *More
  apps*; users must pin it themselves. Admins can pre-pin via Teams
  app setup policies which propagate to Outlook in most cases.
  Acceptable for v1.

## Open questions

- Whether to ship a **default** Entra app registration in
  `server/defaults/` for first-run scaffolding, or require admins to
  bring their own. The add-in doc currently sidesteps this by relying
  on iHub's existing OIDC config; the personal tab introduces a
  *new* Entra surface (Application ID URI + pre-authorized M365
  clients) that needs to be filled in regardless of which auth
  provider iHub itself uses for login.
- Whether to fold the existing `officeIntegration` admin page and
  the new `outlookPersonalTab` page into a single "Microsoft 365"
  admin surface. Probably yes, but not in this concept's first
  cut — keep them separate while the personal tab is in beta.
- Whether to expose iHub's chat surface or the app catalogue as the
  initial landing view. Current proposal: app catalogue (same as the
  web app root). Worth piloting before deciding.

## References

- [Use Agents and Apps across Microsoft 365](https://learn.microsoft.com/en-us/microsoftteams/platform/m365-apps/overview)
- [Extend Personal Tab to Microsoft 365](https://learn.microsoft.com/en-us/microsoftteams/platform/m365-apps/extend-m365-teams-personal-tab)
- [Tab requirements (iframe, X-Frame-Options, CSP)](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/tab-requirements)
- [Nested App Authentication (NAA)](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/authentication/nested-authentication)
- [SSO for tabs (Entra ID)](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-overview)
- [Microsoft 365 app manifest schema reference](https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/)
- [Upload your custom app (sideloading)](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload)
- Internal: [Outlook Add-in Rollout Guide](../../docs/outlook-add-in.md)
- Internal: [Nextcloud Embed concept](../nextcloud-embed/README.md)
