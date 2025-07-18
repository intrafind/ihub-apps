# External Authentication Integration

This concept outlines how AI Hub Apps can rely on a reverse proxy or external service for user authentication. Instead of handling the login flow ourselves, the server will trust user information provided by upstream components such as nginx, Apache, OAuth proxies, or Microsoft Teams.

## Goals

- Support deployments where authentication is already handled outside of the AI Hub Apps server.
- Reuse user identity (name, email, groups) provided by a reverse proxy or platform like Teams.
- Keep the server stateless: every request must include the required headers or tokens.
- Allow mapping of external groups to our internal permission groups.

## Implementation Overview

1. **Configuration**
   - Add a `proxyAuth` section to `platform.json` describing where user data is passed:
     - `enabled`: activate or deactivate the feature.
     - `userHeader`: header name containing the user identifier (e.g. `X-Forwarded-User`).
     - `groupsHeader`: optional header with comma‑separated group names.
     - `jwt` options when tokens are forwarded (issuer, audience, JWK URL).
   - Document the environment variables that can override these settings.

2. **Middleware**
   - Create `server/middleware/proxyAuth.js`.
   - Read the configured headers from each request.
   - If a JWT is present, verify it using `jsonwebtoken` and the provided JWKs.
   - Populate `req.user` with `{ id, name, email, groups }` so downstream routes can perform authorization.
   - If `proxyAuth.enabled` is false or headers are missing, treat the user as anonymous.

3. **Group Mapping**
   - Reuse the existing group‑to‑app mapping logic from the authorization concept.
   - Map incoming group names to internal groups via a configuration file.

4. **Usage in Routes**
   - Update existing route handlers to rely on `req.user` for user information.
   - Continue tracking `x-session-id` or chat ID for analytics, but include the user identifier when available.

5. **Examples and Documentation**
   - Provide example snippets in `docs/server-config.md` showing how to enable proxy authentication.
   - Explain expected headers when deploying behind nginx, OAuth2 Proxy, or when receiving Teams tokens.

## Benefits

- Allows immediate integration with corporate SSO solutions without implementing our own login.
- Keeps the server stateless and scalable.
- Prepares the codebase for a future full authentication layer by normalizing user data early.
