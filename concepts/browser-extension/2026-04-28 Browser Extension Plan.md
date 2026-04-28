# iHub Browser Extension — Concept & Plan

**Date:** 2026-04-28
**Status:** Draft / Planning
**Owners:** TBD
**Related work:** Outlook add-in (`client/src/features/office/`),
Office 365 files integration (`server/services/integrations/Office365Service.js`),
OAuth Authorization Code + PKCE flow (`server/routes/oauth.js`,
`server/routes/oauthAuthorize.js`).

---

## 1. Goal

Build a browser extension that lets a signed-in iHub user pipe the content of
the **current tab** into any of their iHub apps — summarize, translate, draft a
reply, ask a question grounded in the page, etc. — without leaving the page.

The extension is the web-page analogue of the Outlook add-in. The server-side
contract is essentially identical (OAuth + chat API); the new code is the
browser shell and the DOM extractor.

## 2. Non-goals (initial scope)

To keep the first release small and de-risked we explicitly **exclude**:

- **Page automation / agentic actions** — no clicking, typing, form-filling,
  or DOM mutation. This is the part of "Claude for Chrome" / Computer Use that
  carries the most safety and prompt-injection risk; we revisit it once the
  read-only path is mature.
- **Background/idle scraping** — extension only reads the page when the user
  explicitly opens it and triggers an action.
- **Cross-tab orchestration** — single active tab per request.
- **Full-page screenshots of cross-origin frames** — initial release captures
  text only (and optionally same-origin images already in the DOM).
- **Selling per-extension API keys** — no separate billing/quotas; auth and
  quotas piggyback on the user's iHub session.

## 3. Reference points

- **Anthropic / Claude for Chrome** — Anthropic's research preview is the
  closest analogue. Its safety messaging (deny-by-default site allowlist,
  explicit confirmation for sensitive actions, prompt-injection mitigations)
  is the right north star even though we are starting read-only.
- **ChatGPT Sidebar / Perplexity / various "ask the page" extensions** —
  popular pattern: side panel + "Ask about this page" button + a small set of
  prebuilt prompts (Summarize, Translate, Explain).
- **Our own Outlook add-in** — same auth, same chat API, same starter-prompt
  pattern. Most of `client/src/features/office/utilities/buildChatApiMessages.js`
  and `client/src/features/office/api/officeAuth.js` is directly portable.

## 4. User stories

1. As a signed-in user, I install the extension once and connect it to my
   iHub instance by entering the base URL and clicking **Sign in**. PKCE
   handles the rest; my iHub group permissions apply automatically.
2. From any page I open the side panel, pick an iHub app from a list (filtered
   by my permissions, just like the Outlook add-in), and run a starter prompt
   ("Summarize this page", "Extract action items", "Translate to German").
3. I can type a free-form question and the page text is sent as context.
4. I can select a region of the page and send only that selection.
5. Streaming responses appear in the side panel, with the same markdown
   rendering as the main app. I can copy or download the answer.
6. The admin can enable/disable the extension globally, restrict it to a
   specific group, and customise the starter prompts — exactly like the
   Outlook add-in admin page.

## 5. Architecture overview

```
┌──────────────────────────┐        ┌──────────────────────────┐
│ Browser tab (any URL)    │        │ Extension service worker │
│  ─ content script        │ msg →  │  ─ OAuth/PKCE flow       │
│    extracts DOM text     │        │  ─ token storage         │
│    on demand             │ ← msg  │  ─ /api/chat streaming   │
└──────────────────────────┘        │  ─ /api/apps fetch       │
                                    └────────────┬─────────────┘
┌──────────────────────────┐                     │
│ Side panel / popup (UI)  │ msg ─ chrome.runtime│
│  ─ React app             │ ← msg               │
│  ─ app picker            │                     ▼
│  ─ chat surface          │           ┌──────────────────────┐
└──────────────────────────┘           │ iHub server          │
                                       │  /api/oauth/authorize│
                                       │  /api/oauth/token    │
                                       │  /api/chat (SSE)     │
                                       │  /api/apps           │
                                       │  /api/integrations/  │
                                       │    extension/config  │
                                       └──────────────────────┘
```

Three runtime pieces:

1. **Background service worker** — orchestrator. Owns the OAuth flow, holds
   the access/refresh tokens (in `chrome.storage.session` for access,
   `chrome.storage.local` for refresh), forwards chat requests, refreshes on
   401. This is the only piece allowed to talk to the iHub server.
2. **Content script** — injected on demand (`activeTab` permission) when the
   user triggers an action. Extracts page text, optional selection, page
   metadata. Returns a message; never holds a token.
3. **Side panel UI** (Chrome 114+ / Edge; **popup fallback** on Firefox until
   `sidebarAction`/`sidePanel` parity is achieved) — React app that mirrors
   the Outlook taskpane: app picker, chat panel, settings.

The split matches Manifest V3 best practices and keeps tokens out of the page
context (never accessible to a malicious page or content script).

## 6. Authentication — reuse the Outlook flow verbatim

The extension uses the **same OAuth 2.0 Authorization Code + PKCE** flow that
the Outlook add-in uses today. Server-side requires no new endpoints; we just
register a second OAuth client.

**Browser-side flow:**

1. Background worker generates `code_verifier` + `code_challenge` (S256).
2. `chrome.identity.launchWebAuthFlow({ url, interactive: true })` opens
   `${ihubBaseUrl}/api/oauth/authorize?...` and waits for the callback URL.
3. The redirect URI is the extension's
   `https://<extension-id>.chromiumapp.org/cb` (Chromium) or
   `https://<extension-id>.extensions.allizom.org/cb` (Firefox) — both must
   be registered on the OAuth client's `redirectUris` allowlist.
4. The worker exchanges the code via `POST /api/oauth/token`, stores tokens,
   and refreshes them transparently on 401 (the Outlook add-in already has
   this loop; we lift it from `client/src/features/office/api/officeAuth.js`).

**Server-side change:** one new admin route, modeled exactly on
`server/routes/admin/officeIntegration.js`:

- `POST /api/admin/extension-integration/enable` — creates a public OAuth
  client called "Browser Extension" with `grantTypes: [authorization_code,
  refresh_token]` and the per-browser redirect URIs above.
- `PUT /api/admin/extension-integration/config` — localized display name,
  description, and starter prompts (same shape as the Office add-in).
- `GET /api/integrations/extension/config` — public runtime config for the
  extension to fetch on startup (same shape as
  `GET /api/integrations/office-addin/config`: clientId, redirectUris,
  starterPrompts, enabled flag).

Because the extension authenticates **as the user** via PKCE, the user's
existing iHub group membership and permissions apply for free — same as the
Outlook add-in. No new permission plumbing.

## 7. Authorization — the new `extension` group

We expose a coarse on/off switch via a new built-in group, mirroring how the
Outlook integration could (today, the Outlook integration relies on the
default `users` group, but the user has expressed a preference for a dedicated
group here).

**`contents/config/groups.json` addition:**

```jsonc
{
  "groups": {
    "extension": {
      "id": "extension",
      "name": "Browser Extension Users",
      "description": "Users allowed to use the iHub browser extension",
      "inherits": ["users"],
      "permissions": {
        "apps": [],          // merged with parent; or restrict here
        "models": [],
        "adminAccess": false
      }
    }
  }
}
```

**Server-side enforcement:** the existing OAuth client's optional `allowedApps`
/`allowedGroups` filter is sufficient — when the admin creates the extension's
OAuth client we pin it to the `extension` group via a new `allowedGroups`
field on the OAuth client (small addition to
`server/utils/oauthClientManager.js`, mirroring `allowedApps`/`allowedModels`).
At authorize time, if the signed-in user is not in `allowedGroups`, the consent
screen rejects the flow with a clear message ("This account is not enabled for
the browser extension. Please contact your administrator.").

This matches the user's stated preference: a dedicated permission group that
the admin can populate with extension-eligible users without granting them
anything new in the main UI, or vice versa.

**Migration:** add a versioned migration
(`server/migrations/V{NNN}__add_extension_group.js`) that uses
`ctx.setDefault` to add the `extension` group entry if it is missing.

## 8. Page content extraction

The content script's job is to produce a clean, LLM-ready representation of
the page **on demand**. Initial implementation:

```js
// content-script.js (sketch)
function extractPage({ selectionOnly = false } = {}) {
  const url = location.href;
  const title = document.title;

  if (selectionOnly) {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) {
      return { url, title, mode: 'selection', text: sel.toString() };
    }
  }

  // Reuse Mozilla Readability for article extraction; fall back to body text.
  const docClone = document.cloneNode(true);
  const article = new Readability(docClone).parse();
  const text = article?.textContent
    ?? document.body.innerText.slice(0, 200_000);

  return {
    url,
    title,
    mode: article ? 'readability' : 'fallback',
    text,
    excerpt: article?.excerpt,
    byline: article?.byline,
    siteName: article?.siteName,
  };
}
```

Notes:

- **Readability** (`@mozilla/readability`) gives us the same article extraction
  Firefox Reader View uses. Bundle it; no remote code execution.
- **Cap text length** at e.g. 200k chars before the round-trip. The server
  enforces token limits per app, but bandwidth/responsiveness benefit from a
  client-side cap.
- **Selection mode** wins if a non-empty selection exists.
- **Frames / iframes** — initial release ignores cross-origin frames. Same-
  origin frames can be walked if needed.
- **PDFs in tab** — Chromium PDF viewer is special; first release detects this
  and shows "this tab type isn't supported yet" (we can add a server-side PDF
  fetch later).

The extracted payload is shipped to `/api/chat` using the same
`fileData`/`imageData` shape the Outlook add-in already uses
(`client/src/features/office/utilities/buildChatApiMessages.js`):

```js
fileData: [{
  source: 'web_page',
  fileName: `${slugify(title)}.md`,
  fileType: 'text/markdown',
  displayType: 'text/markdown',
  content: `# ${title}\n\nSource: ${url}\n\n${text}`,
}]
```

This means **zero server-side changes** for ingesting page content — the chat
pipeline already knows how to attach `fileData` to a user message.

## 9. UI surface

- **Primary:** Chrome / Edge **Side Panel** (Manifest V3 `side_panel` API,
  Chrome 114+). Persistent across tab switches, ~360–420px wide; right size
  for chat.
- **Fallback:** **Popup** for browsers without side panel parity (Firefox
  until they ship `sidePanel`). Same React tree, different mount point.
- **Content:** lift the existing Outlook UI almost wholesale —
  `OfficeApp.jsx`, `OfficeChatPanel.jsx`, `OfficeLogin.jsx`, the apps picker,
  the variables dialog. The same `useOfficeChatAdapter` hook works against
  `/api/chat` regardless of host (Outlook taskpane vs. browser side panel).
  Rename to a neutral `client/src/features/embedded-client/` so it's no
  longer Office-specific, and have both Outlook and the extension import
  from it (see §11).
- **Page-aware affordances:**
  - "Send page", "Send selection", "Ask about this page" buttons in the side
    panel header.
  - Optional context chip showing page title + favicon while a request is
    in flight.

## 10. Manifest V3 sketch

```jsonc
{
  "manifest_version": 3,
  "name": "iHub Apps",
  "version": "0.1.0",
  "permissions": [
    "activeTab",
    "storage",
    "identity",
    "scripting",
    "sidePanel"
  ],
  "host_permissions": [],          // none baseline; user supplies iHub URL
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "iHub Apps" },
  "content_scripts": [],           // injected on demand via scripting API
  "web_accessible_resources": [],
  "options_page": "options.html"
}
```

Key choices:

- **`activeTab` + on-demand `scripting.executeScript`** instead of a static
  `content_scripts` block. The extension only touches a page when the user
  clicks. This is the safest posture and the one Anthropic uses for Claude
  for Chrome.
- **`<all_urls>` is optional** — the user grants per-site or "on click"
  access. Default to "on click".
- **No `host_permissions` at install time** for the iHub origin either; we
  inject it dynamically via `chrome.permissions.request` after the user
  enters their iHub URL (avoids review friction and prevents the extension
  from shipping with a hard-coded company domain).

## 11. Reuse map — what we lift from the Outlook add-in

| Outlook add-in file                                                | Reused as                          | Changes                              |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------ |
| `client/src/features/office/api/officeAuth.js`                     | `embedded-client/api/auth.js`      | Replace `localStorage` with `chrome.storage`; replace redirect URI |
| `client/src/features/office/api/officeAuthBridge.js`               | `embedded-client/api/authBridge.js`| Adapt to `chrome.identity.launchWebAuthFlow` |
| `client/src/features/office/utilities/buildChatApiMessages.js`     | unchanged module                   | Add `extractFromWebPage()` builder alongside `buildImageDataFromMailAttachments` |
| `client/src/features/office/hooks/useOfficeChatAdapter.js`         | `useChatAdapter.js`                | Drop Office.js imports; same API |
| `client/src/features/office/components/OfficeApp.jsx`              | `EmbeddedApp.jsx`                  | Strip Office.js init; mount in side panel |
| `client/src/features/office/components/OfficeChatPanel.jsx`        | `EmbeddedChatPanel.jsx`            | Same |
| `client/src/features/office/components/apps-dialog/index.jsx`      | unchanged                          | — |
| `server/routes/admin/officeIntegration.js`                         | `extensionIntegration.js`          | Same shape; different OAuth client name + redirect URIs |
| `server/routes/integrations/officeAddin.js`                        | `integrations/extension.js`        | Drop manifest XML; keep runtime config |

Estimated new code: ~30–40% of total. The rest is rename + small adapters.

## 12. Privacy & security

- **Tokens never leave the service worker.** Content scripts and the side
  panel get tokens *only* indirectly via message-passed API calls.
- **Page content is sent to the iHub server only on explicit user action.**
  No telemetry, no background scrape.
- **Sensitive-page heuristic.** Banking, password manager, healthcare URLs
  trigger an extra confirmation ("This page may contain sensitive
  information. Send to iHub?") — same spirit as Claude for Chrome's
  high-risk-site warning.
- **Prompt-injection mitigation.** Page text is wrapped in an explicit
  envelope (`<page>…</page>`) with a system note that "untrusted page content
  follows". This is a server-side prompt addition, not a foolproof defense,
  but raises the bar.
- **Site allowlist / blocklist** (admin-configurable, optional) — admin can
  restrict the extension to specific origins, or block specific origins.
  Lives in the same admin config as the starter prompts.
- **Self-hosted iHub URL** — extension stores the user-entered base URL and
  validates it (HTTPS only, except `localhost` for dev) before issuing any
  request.
- **Refresh token** stored in `chrome.storage.local` (encrypted-at-rest by
  the OS keychain on Chrome 122+). Access token in `chrome.storage.session`
  (cleared on browser restart).

## 13. Phased rollout

**Phase 1 — Read-only MVP (4–6 weeks)**

- Server: extension admin endpoint, OAuth client autocreate, runtime config,
  `extension` group migration, `allowedGroups` on OAuth clients.
- Client: extract `embedded-client/` module from `features/office/`; both
  Outlook and the extension consume it.
- Extension: Manifest V3 shell, side panel UI, OAuth flow, content extractor
  (Readability + selection), starter prompts, Chrome + Edge.
- QA: internal dogfood, then opt-in beta to a small group.

**Phase 2 — Polish & breadth (3–4 weeks)**

- Firefox build (popup fallback, signing).
- Per-site allowlist UX (`chrome.permissions.request` flows).
- PDF tab support (server-side fetch & render).
- Right-click context menu actions ("Summarize selection", "Translate
  selection").
- Telemetry (server-side, group-scoped) for adoption.

**Phase 3 — Authorized actions (later, scoped separately)**

- Allow the extension to type into the active tab on user confirmation
  (e.g. "insert this draft reply into the Gmail compose box"). Requires its
  own design doc; not in this plan.

## 14. Open questions

1. **Browser store distribution** — do we ship to the public Chrome Web
   Store or distribute privately (admin-uploaded `.crx` / Edge for Business
   policy)? Affects review timelines and whether `<all_urls>` is acceptable.
2. **Multi-tenant iHub** — most customers have one iHub URL per user, but
   should the extension support multiple iHub instances side-by-side? Easy
   to add, but adds UI complexity.
3. **Group rollout strategy** — should the new `extension` group be
   pre-populated (everyone in `users` joins it) or opt-in? Recommendation:
   opt-in, admin enables explicitly.
4. **Do we want the extension to surface server-side sources?** (e.g. let a
   user choose to ground the answer in iHub's FAQ source as well as the
   current page.) Likely yes — the apps picker already supports this.
5. **Brand name** — "iHub Apps for Chrome", "iHub Sidekick", etc. Naming +
   Web Store listing copy is its own work item.

## 15. Effort estimate

| Workstream                                   | Effort       |
| -------------------------------------------- | ------------ |
| Server admin/integration endpoint + migration| 2–3 days     |
| `allowedGroups` on OAuth client              | 1 day        |
| Extract shared `embedded-client/` from Office| 3–4 days     |
| Extension shell (manifest, SW, side panel)   | 4–5 days     |
| OAuth/PKCE wiring in service worker          | 2–3 days     |
| DOM extractor + Readability integration      | 2–3 days     |
| Admin UI for extension config                | 2–3 days     |
| QA, packaging, store listing assets          | 4–5 days     |
| **Total (Phase 1)**                          | **~4–6 wks** |

## 16. Success criteria

- A user can sign in to the extension and run "Summarize this page" against
  any public article in under 10 seconds end-to-end.
- The extension respects the user's iHub group permissions: the apps list
  matches what they see in the main web app.
- Admin can disable the integration from the admin UI and existing
  extension instances stop working within one token-refresh cycle.
- No new server-side LLM endpoints are needed; the extension uses
  `/api/chat` exactly like the Outlook add-in does today.
