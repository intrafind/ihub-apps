# Preconfigured MCP Server Catalog

## Goal

Admins connecting iHub to a hosted MCP server had to find the endpoint, the transport and the
authentication scheme themselves. iHub now ships a catalog of hosted servers under
**Admin → MCP servers → Browse catalog**. Picking one pre-fills the create form; the admin adds
the key, tests and saves.

## Review

74 widely offered hosted MCP servers were reviewed against the vendors' own documentation, and
each endpoint was probed with an unauthenticated `initialize` request (September 2026). The
deciding question for each one: can a backend connect **with one shared credential**, without an
interactive login per user? That is all iHub's outbound client supports today:

| iHub auth type | Sends                                                             |
| -------------- | ----------------------------------------------------------------- |
| `none`         | nothing                                                           |
| `bearer`       | `Authorization: Bearer <secret>`                                  |
| `header` (new) | `<headerName>: <valuePrefix><secret>`                             |
| `basic`        | `Authorization: Basic base64(user:secret)`                        |
| `oauth`        | client-credentials token, form-encoded request to the token URL   |

Result: **37 servers in the catalog**, 37 left out.

### In the catalog

| Category                 | Servers                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Documentation            | Microsoft Learn, Context7, DeepWiki, Astro Docs (all without key)                                        |
| Development & operations | GitHub, Sentry, Postman, Cloudflare, Supabase, Neon, Render, Buildkite, Honeycomb, PagerDuty, Braintrust |
| Productivity             | Atlassian (Jira & Confluence), Linear, monday.com, Coda                                                  |
| Content & media          | Sanity, Cloudinary, Wix                                                                                  |
| Automation & web         | Zapier, Apify, Browser Use, superglue                                                                    |
| Sales & support          | Close, Intercom, Fireflies.ai, Modjo                                                                     |
| Analytics                | PostHog                                                                                                  |
| Data & research          | Hugging Face (without key), Google Maps, Statista, PRIMAMCP                                              |
| Finance & payments       | Stripe, Debitura                                                                                         |

Notes that shaped entries:

- Several URLs in circulation are outdated: Atlassian `/v1/sse` stopped working after
  30 June 2026 (now `/v2/mcp`), monday.com, Intercom, PostHog, PagerDuty and Cloudinary moved from
  `/sse` to `/mcp`, Zapier to `/api/v1/connect`, Browser Use to `/v3/mcp`, and the legal-research
  server formerly called Lawbster to `mcp.planitprima.com/mcp`.
- Non-standard schemes need the new `header` auth type: Sentry (`Authorization: Sentry-Bearer`),
  PagerDuty (`Authorization: Token token=`), Wix (raw key in `Authorization`), Google Maps
  (`X-Goog-Api-Key`), Statista (`x-api-key`), Browser Use (`X-Browser-Use-API-Key`), Close
  (`Close-API-Key`) and Cloudinary (`cloudinary-url`).
- Close (`Close-Scope`) and Wix (`wix-account-id`) also need a non-secret second header, which
  is what the new static `transport.headers` carries.
- Buildkite accepts tokens only on `/direct`; `/mcp` is OAuth only.
- Cloudflare's product servers (bindings, observability, …) document OAuth only; the catalog
  lists the Cloudflare API server (`mcp.cloudflare.com/mcp`), which documents API tokens.
- Stripe rejects secret and restricted keys without the Agent tag from 31 October 2026; the entry
  asks for an agent key.
- Hugging Face and Context7 work without a key, so they are listed keyless with a note on adding
  one.

### Left out

| Reason                                                                   | Servers                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive OAuth login per user only                                    | Amplitude, Ashby, Asana, Attio, Canva, ClickUp, Demodesk, HubSpot, Jamie, Klardaten, Leadfeeder, Miro, Mobbin, Notion, Pennylane, Pipedrive, Prisma, Ramp, SISTRIX (API keys refused since 31 Aug 2026), Spendesk, Square, Stack Overflow, Stytch, Supercut, TaxGraph, Typeform, Vercel |
| Static token documented only for the local package, or not at all        | InstantDB, Netlify, Replicate, Semgrep (hosted server now answers with an OAuth challenge), Lazyweb (token only obtainable through its installer)                                                                                          |
| Client-credentials variants iHub's `oauth` type does not speak           | Plaid (JSON token request), PayPal (token request with Basic client auth, undocumented for MCP), Pipedream (plus four `x-pd-*` headers, one of them per end user)                                                                          |
| Renders its result as an MCP App (iframe UI), which iHub does not display | draw.io, Excalidraw                                                                                                                                                                                                                      |

## Bugs Found on the Way

Probing the first catalog entry through iHub's own client showed that outbound HTTP MCP did not
work at all:

1. `McpServerConnection`'s pinned fetch merged headers with `{ ...init.headers }`. The SDK passes
   a `Headers` instance, which spreads to `{}`, so `Content-Type`, `Accept`, `Mcp-Session-Id`
   and `Mcp-Protocol-Version` were dropped. Servers answered
   `request content type '' is not a known JSON content type`.
2. `safeFetch` handed an Agent from the npm `undici` (8.x) to Node's built-in `fetch`, which
   bundles its own undici (6.x) with an incompatible handler API. Every call threw
   `UND_ERR_INVALID_ARG` and fell back to a buffered `http.request` shim without a streaming
   body, so SSE responses never completed. `safeFetch` now uses `undici.fetch` with the matching
   Agent.

The SSE transport's message POSTs also bypassed the pinned fetch; they now use it too.

## Design

- **Catalog data** — `server/services/mcp/serverCatalog.js`, a plain module shipped with the
  server. No config file and no migration: the catalog is a template source, not configuration,
  and updates with each release. Entries carry `transport`, an `auth` template without the
  credential reference, `credentialHint`, `notes` and `description` (en + de), `docsUrl`,
  `category`, `tags`.
- **API** — `GET /api/admin/mcp/catalog` (admin only) returns the categories and entries, each
  flagged `installed` when a configured server shares its id or endpoint URL.
- **UI** — `McpServerCatalogDialog` (search, category filter, cards). Choosing an entry opens the
  existing create dialog pre-filled, with a hint panel for the credential and notes. The id gets a
  `-2`, `-3` suffix when taken.
- **Schema** — `auth.type: 'header'` (`headerName`, optional `valuePrefix`, `valueRef`) and
  optional `transport.headers` on `streamableHttp`/`sse`. Header names must be RFC 9110 tokens;
  transport-owned names (`Host`, `Content-Type`, `Accept`, `Mcp-Session-Id`, …) are refused;
  static headers refuse `Authorization` so secrets stay in the credential store; values may not
  contain line breaks. Additive — existing configs are unchanged.
- **Tests** — `server/tests/mcp/serverCatalog.test.js` turns every entry into a server config and
  validates it against the schema, and checks ids, categories, https URLs and en/de texts.

## Next Step: Per-User Outbound OAuth

27 of the 37 servers left out — including Notion, Asana, HubSpot, Miro, Canva, ClickUp and
Vercel — need each user to sign in with their own account. Supporting them means an outbound
OAuth 2.1 client in iHub: authorization code with PKCE, client registration via Client ID Metadata
Documents (preferred by the 2025-11-25 MCP spec) or dynamic client registration, per-user token
storage and refresh, and a per-user connection instead of one shared connection per server. That
also changes the permission model — tool calls would run as the calling user, not as a shared
service identity. Worth a separate concept before implementation.

Smaller follow-ups: a JSON-body and Basic-client-auth option for the `oauth` type would add Plaid
and PayPal.
