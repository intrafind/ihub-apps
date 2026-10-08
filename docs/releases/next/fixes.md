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

## Security Updates for Trusted Proxy Subnets and MCP Server Sign-in

Two vulnerabilities in bundled libraries are fixed.

- **Trusted proxy subnets:** with `trustProxy` set to an address or subnet list (for example
  `loopback, 10.0.0.0/8`), a client connecting over an IPv4-mapped IPv6 address could pass as a
  trusted proxy and choose its own client IP through `X-Forwarded-For` (GHSA-jqcg-44mw-7w3h). The
  default of one trusted proxy hop was not affected.
- **MCP server sign-in:** when a user signed in to an OAuth-protected MCP server, the MCP server
  could make iHub send OAuth credentials to an authorization server of its choosing
  (GHSA-6qxp-vccf-f47h).
