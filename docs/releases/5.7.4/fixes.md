# Fixes — 5.7.4

## Attached HTML and SVG files no longer run script when opened directly

An HTML, XHTML or SVG file attached to a chat, a shared chat or a scheduled task run was served
with its own content type from the iHub address. Opening it directly could therefore run its
script in the context of the signed-in user.

- These files are now served with a sandboxing `Content-Security-Policy`, so they still display
  but cannot run script or reach the session.
- PDFs and other attachment types are unchanged.

## MCP Gateway and A2A Endpoints Follow the API Rate Limit

The MCP gateway (`/mcp`), the A2A routes (`/a2a`), the MCP OAuth callback and the OAuth client
metadata document had no request limit.
They now count against `rateLimit.publicApi`. A signed-in caller counts per user or OAuth client,
so many people behind one proxy or one hosted MCP client do not share a bucket.

- Anonymous requests count per address. The OAuth client metadata document, which authorization
  servers fetch without credentials, and the OAuth callback share one per-address budget.

- Clients that exceed the limit receive `429 Too Many Requests`.
- Raise `rateLimit.publicApi` in `platform.json` if an automation legitimately needs more.

## Office Add-in and Browser Extension Reject Malformed iHub Addresses

An iHub address that is not an absolute `http(s)` URL now produces a clear error when signing in
from the Office add-in or the browser extension, instead of failing later in the sign-in flow.
Links that are not `http(s)` no longer open from sources, project documents or the connect flow.

## Admin rate limit now covers `POST /api/completions`

`POST /api/completions`, which administrators and content admins use to test prompts, called a
model without any rate limit. It now shares the admin rate limit under
**Platform → Security → Rate Limits** with the other admin requests.

## Group and OAuth client pages open with an app that has no English name

The app picker on the page of a group with an explicit app list, and on an OAuth client page,
could fail with an error when an app had its name in one language other than English, for example
only in German. The picker expected an English name for every app.

- The picker now shows and searches the name in the language of the user interface, then in
  another language the app has, then the app's ID.
- The header of the app editor shows such an app by its name instead of its ID.
