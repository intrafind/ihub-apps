# External Authentication Integration

This concept outlines how AI Hub Apps can rely on a reverse proxy or external service for user authentication. Instead of handling the login flow ourselves, the server will trust user information provided by upstream components such as nginx, Apache, OAuth proxies, or Microsoft Teams. The long term goal is to support both this "proxy" mode and a full OpenID Connect (OIDC) flow managed by the server itself.

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
     - `jwtProviders`: array of JWT provider configs. Each entry specifies:
       - `header`: name of the header containing the token (default `Authorization`).
       - `issuer`/`audience` values expected in the token claims.
       - `jwkUrl`: location of the JSON Web Key Set for verifying the signature.
   - Environment variables (e.g. `PROXY_AUTH_ENABLED`, `PROXY_AUTH_USER_HEADER`) can override the values in `platform.json` so deployments may adjust settings without editing the file.

2. **Middleware**
   - Create `server/middleware/proxyAuth.js`.
   - Read the configured headers from each request.
   - If a JWT is present, determine the matching provider from `jwtProviders` and verify the token using `jsonwebtoken` and the provider's JWKs.
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

## Next Step: Built-in OIDC Support

After the proxy mode is stable we will integrate full OIDC login in the server. This keeps the platform flexible for customers that cannot provide authenticated headers.

1. **Provider Configuration**
   - Introduce an `authProviders` array in `platform.json` with one entry per OIDC provider.
   - Each provider defines `issuer`, `clientId`, `clientSecret`, `scopes`, and `jwkUrl` for token validation.
   - Multiple providers can coexist so different customers may use their own identity systems.

2. **Passport.js Integration**
   - Use Passport.js strategies for each configured provider to handle the login redirect and callback.
   - Upon successful authentication normalize the user profile and groups the same way as the proxy mode.
   - Issue a short lived token signed by the server so subsequent requests remain stateless.

3. **Compatibility with Proxy Mode**
   - Both proxy authentication and server managed OIDC can be enabled. If a valid JWT from a proxy is present it is used; otherwise the user may go through the OIDC login flow.

This two phase approach ensures the server can integrate with existing SSO setups immediately while paving the way for a self contained authentication option.

## Client Login Flow Configuration

The frontend loads `/api/configs/platform` during startup. This response will contain an `auth` section describing how users are expected to authenticate. The UI then chooses the appropriate flow:

- `mode: "proxy"` – The client starts an external login (e.g., Microsoft Teams or a corporate SSO page) and receives a JWT. This token is forwarded to the server using the header defined in `proxyAuth.jwtProviders[*].header`.
- `mode: "local"` – The user enters a username and password directly in the UI. The credentials are sent to `/api/login`, the server verifies them, and replies with its own JWT.
- `mode: "oidc"` – The UI redirects the browser to a server endpoint which starts an OIDC flow via Passport.js. After the provider calls back, the server issues a JWT for subsequent requests.

The chosen mode can be overridden with an `AUTH_MODE` environment variable so deployments can switch authentication strategies without rebuilding the client.
