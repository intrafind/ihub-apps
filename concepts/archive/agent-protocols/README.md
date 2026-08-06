# Agent Protocols (MCP, A2A) for iHub Apps and iFinder

This folder collects the strategy and design documents for exposing iHub Apps and iFinder to external LLM hosts and autonomous agents — Claude Desktop, Claude Code, Cursor, Continue, Cowork, ChatGPT custom connectors, and any future MCP/A2A-capable client.

## Documents

| Document | Description |
|----------|-------------|
| [Agent Protocol Strategy](2026-05-06%20Agent%20Protocol%20Strategy.md) | Landscape analysis (MCP, A2A, plugins, skills), recommended architecture, phased rollout, open questions |
| [Auth Flow Reference](2026-05-06%20Auth%20Flow%20Reference.md) | Sequence diagrams, scope design, token claims, RFC 9728 metadata example, headless/CLI flow |

## Quick Decision Summary

**Question:** Build plugins, skills, an MCP server, A2A, or some combination?

**Recommendation:** **MCP server is the contract.** Skills and plugins live in the client; they cannot replace a server-side protocol. A2A is complementary and worth adding in a later phase.

| Layer | What it is | Where it lives | iHub's role |
|-------|------------|----------------|-------------|
| Skills | Prompt-time behavior packs loaded into the LLM | Client (Claude Desktop, Cowork) | Optional — ship a "How to use iHub" skill alongside the connector |
| Plugins | Bundles of MCP servers + skills + tools, host-specific (Claude Code plugins, Cowork plugins) | Client | Optional — package one for Claude Code users |
| **MCP server** | **The wire protocol every modern host speaks** | **Server (iHub / iFinder)** | **Primary deliverable** |
| Connector Directory entry | Anthropic-curated, one-click install in Claude apps | Anthropic-hosted listing | Submit after MCP server is stable |
| A2A | Peer-to-peer agent protocol (Linux Foundation) | Server (separate or same endpoint) | Phase 2, wraps the same tool surface |
| OpenAI-compatible API | `/v1/chat/completions` for clients that send chat to iHub | Already shipping | Complementary — different direction of traffic |

## Why MCP first

- **Existing foundation already covers ~70%.** The OAuth 2.1 Authorization Code Flow with PKCE landing in V007 (`concepts/oauth-authorization-code-flow/`), combined with the OAuth 2.0 Client Credentials work from January 2026, gives iHub everything an OAuth 2.1 resource server needs: discovery doc, JWKS, authorize/token/userinfo/revoke endpoints, scopes, refresh tokens, and group-based permissions. The MCP spec maps almost 1:1 onto these primitives.
- **Reach.** Claude Desktop, Claude Code, Cowork, Cursor, Continue, ChatGPT custom connectors, Goose, and most enterprise agent frameworks all speak MCP. A single endpoint covers them all.
- **Auth model fits.** MCP requires user-context auth via OAuth 2.1. iHub's existing group/permission system, intersected with per-client `allowedApps`/`allowedModels`, gives us exactly the "user can only see what they're allowed to see" property the user requested.
- **Tool surface already exists.** Apps, tools, workflows, and sources are all addressable resources today. Exposing them via MCP is mostly a thin adapter layer, not new functionality.

## Recommended phased plan

| Phase | Goal | Effort | Depends on |
|-------|------|--------|------------|
| **0** | This audit (current) | 0.5 day | — |
| **1 — MCP MVP with PAT auth** | Streamable HTTP `/mcp` endpoint, expose tools+apps+workflows, manual PAT (existing static API key) for Claude Code / Cursor / curl. Get one connector working end-to-end. | ~1 week | Existing `client_credentials` (done) |
| **2 — MCP with OAuth + DCR** | Add RFC 9728 Protected Resource Metadata, expose existing OAuth flow as the AS, wire DCR. Claude Desktop one-click install works. | ~2 weeks | V007 OAuth Authz Code Flow |
| **3 — Connector Directory submission** | Polish UX, write usage docs, submit to Anthropic Connector Directory. Optional: Claude Code plugin package. | ~1 week | Phase 2 stable |
| **4 — iFinder MCP server** | Mirror the architecture for iFinder's search/retrieval surface. Either standalone OAuth AS or use iHub's. | ~2 weeks | Phase 2 patterns |
| **5 — A2A wrapper** | Publish Agent Cards, wrap existing MCP tools as A2A skills, support OAuth bearer auth scheme. | ~1 week | Phase 2 stable |

## Authentication: OAuth primary, PAT fallback

Per the user's decision, the doc covers both paths. They map cleanly onto what's already in iHub:

- **OAuth 2.1 Authorization Code + PKCE** (interactive desktop clients like Claude Desktop) → `oauth_authorization_code` authMode → user identity in JWT (`sub` = user.id), permissions intersected with client config.
- **PAT / static API keys** (Claude Code, scripts, headless A2A peers) → existing `oauth_static_api_key` authMode → admin-issued long-lived token bound to a specific user, scoped to apps/models the admin allows.
- **Client Credentials** (server-to-server, machine identity) → `oauth_client_credentials` → for non-user-context use cases (rare for the agent surface, but already supported).

The Auth Flow Reference doc contains the sequence diagrams and the scope design.

## Open questions for the team

1. **DCR vs CIMD** — DCR (RFC 7591) is what most MCP clients implement today; CIMD is the emerging cleaner alternative. Recommendation: ship DCR first, watch CIMD adoption, add later.
2. **Trusted client list** — should Anthropic's Claude Desktop (and other major hosts) be pre-registered with a stable `client_id` to skip consent for first-party feel? Or always require consent?
3. **Scope granularity** — coarse (`mcp:read`, `mcp:write`) or fine (`mcp:apps:<id>`, `mcp:tools:<name>`)? Recommendation: ship coarse, allow fine via existing `allowedApps`/`allowedModels` on the OAuth client record.
4. **Audit & rate limiting** — MCP traffic should flow through the existing audit log + rate limiter paths. Confirm that the same per-user quotas apply.
5. **iFinder ownership and AS choice** — does iFinder run its own OAuth AS or federate with iHub's? The latter is simpler for users with one identity; the former preserves product independence.
6. **Multi-tenant story** — today iHub deployments are single-tenant. If we want one MCP endpoint per tenant, we need either subdomain or path-based tenant routing, both of which RFC 9728 supports.

## Supersedes / relates to

- Supersedes: `concepts/2025-07-22 Model Context Protocol Server.md` — that earlier sketch predates the MCP OAuth 2.1 spec (March 2025) and the Streamable HTTP transport. The strategy doc here folds in its tool-exposure idea but rebuilds the auth story.
- Builds on: `concepts/oauth-authorization-code-flow/` — the OAuth AS this strategy treats as a hard dependency.
- Builds on: `concepts/2026-01-19 OAuth2 Client Credentials External API Authentication.md` — the existing `client_credentials` and static API key infrastructure.
- Complements: `concepts/2025-07-12 OpenAI Compatible API.md` — that endpoint lets clients send chat *to* iHub via the OpenAI shape; MCP lets agents drive iHub's apps and tools.

---

**Author:** Daniel Manzke (with research synthesis)
**Date:** 2026-05-06
**Status:** Draft for team review
