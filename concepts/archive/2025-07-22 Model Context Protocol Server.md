# Model Context Protocol Server

## Summary

This concept outlines how to implement a server that exposes our apps as tools via the Model Context Protocol (MCP). Similar to the OpenAI‑compatible API, the MCP endpoints must validate a bearer token. Tokens can be issued for server‑to‑server communication or per user by the admin interface. Each token specifies whether it can access models, apps, or both.

## Goals

- Allow MCP clients to discover and invoke apps as tools.
- Share a unified API token mechanism across MCP and OpenAI‑style endpoints.
- Provide admin functionality to create and manage scoped API tokens.

## Implementation Overview

1. **MCP Endpoints**
   - Add a new route module `server/routes/mcpRoutes.js` registered in `server/server.js`.
   - `/mcp/tools` returns a list of tool descriptors derived from app configurations.
   - Future MCP routes (e.g., `/mcp/openapi`) can expose schemas or metadata.

2. **Token Verification**
   - Introduce middleware that checks `Authorization: Bearer <token>` for MCP and OpenAI‑compatible routes.
   - Tokens are defined under a new `apiTokens` section in `platform.json` and may also be stored in a dedicated file for user‑generated tokens.
   - Each token record contains a hashed value, optional expiry, and allowed usages (`models`, `apps`).

3. **Admin Management**
   - Extend admin routes with endpoints to list, create, and revoke tokens.
   - Admin UI allows generating a token, selecting allowed apps or models, and storing the hash.

4. **App Exposure as Tools**
   - Apps intended for MCP discovery include `exposeAsTool: true` and optional tool metadata such as `parameters`.
   - `mcpRoutes.js` reads the app list from `configCache` and emits tool definitions compatible with MCP.

5. **Documentation Updates**
   - Document the new `apiTokens` configuration and MCP endpoints in `docs/server-config.md`.
   - Provide usage examples for server‑side tokens and user tokens.

## Future Work

- Support token creation via CLI for automated environments.
- Expand the MCP implementation to cover additional endpoints defined by the specification.
- Track token usage for audit purposes in `data/` metrics.
