# Fixes — Unreleased

## Security Updates for Trusted Proxy Subnets and MCP Server Sign-in

Two vulnerabilities in bundled libraries are fixed.

- **Trusted proxy subnets:** with `trustProxy` set to an address or subnet list (for example
  `loopback, 10.0.0.0/8`), a client connecting over an IPv4-mapped IPv6 address could pass as a
  trusted proxy and choose its own client IP through `X-Forwarded-For` (GHSA-jqcg-44mw-7w3h). The
  default of one trusted proxy hop was not affected.
- **MCP server sign-in:** when a user signed in to an OAuth-protected MCP server, the MCP server
  could make iHub send OAuth credentials to an authorization server of its choosing
  (GHSA-6qxp-vccf-f47h).
