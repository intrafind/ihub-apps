# Fixes — Unreleased

## Local and Self-Hosted Models Work Without an API Key

Chat with a model on a local server (provider **Local**: vLLM, LM Studio, Jan.ai, Ollama) failed
with `API_KEY_ERROR` unless some key was set — even though the setup guide says no key is needed.
The only way out was to type a dummy value, such as spaces, into the model's API key field.

- A **Local** model without a key now runs; the request goes out without an `Authorization` header
  instead of a meaningless `Bearer` value.
- The same applies to an OpenAI-compatible server reached through the **OpenAI** API type at your
  own URL (not `api.openai.com`) that is not linked to a custom provider. A key that is
  configured is still sent.
- OpenAI's own endpoint, and models linked to a custom provider, still need a key.
- OCR with a keyless local model no longer stops with "No API key configured".
- The start-up check for missing keys and the chat request now agree on which models need one.

Models that carry a blank key (spaces) keep working as before.

## Backup Imports, iFinder Downloads and the Container Entrypoint Are Locked Down

Importing a backup placed the uploaded archive — and the configuration extracted from it, secrets
included — in the shared system temp directory with default file permissions. iFinder document
downloads were written to `/tmp/ifinder-downloads` the same way, so other local users on the host
could read them.

- Each backup import now uses its own private directory (owner-only access) that is removed when
  the import finishes.
- The iFinder download directory is created owner-only. A directory that already exists keeps its
  permissions — on an existing installation run `chmod 700` on it (default `/tmp/ifinder-downloads`,
  or the configured `downloadDir`).
- In the Docker image the entrypoint script is now owned by root, so the application user cannot
  rewrite the script it is started through.

## Copy Buttons Only Report "Copied" When the Copy Worked

Some copy buttons showed "Copied to clipboard" even when the browser had refused the copy — for
example when clipboard access was blocked. The confirmation now appears only after the text really
reached the clipboard.

- Affects the copy buttons for generated tokens on the OAuth clients page, the OAuth server page
  and the Copilot agent setup page.
- A refused copy is logged in the browser console instead of surfacing as an unhandled error.

## Security Updates for Trusted Proxy Subnets and MCP Server Sign-in

Two vulnerabilities in bundled libraries are fixed.

- **Trusted proxy subnets:** with `trustProxy` set to an address or subnet list (for example
  `loopback, 10.0.0.0/8`), a client connecting over an IPv4-mapped IPv6 address could pass as a
  trusted proxy and choose its own client IP through `X-Forwarded-For` (GHSA-jqcg-44mw-7w3h). The
  default of one trusted proxy hop was not affected.
- **MCP server sign-in:** when a user signed in to an OAuth-protected MCP server, the MCP server
  could make iHub send OAuth credentials to an authorization server of its choosing
  (GHSA-6qxp-vccf-f47h).
