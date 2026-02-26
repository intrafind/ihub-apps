# iHub OAuth Client Example

A standalone example application demonstrating OAuth 2.0 Authorization Code Flow with PKCE against iHub as an identity provider.

## Prerequisites

- iHub running locally at `http://localhost:3000`
- An OAuth client configured in iHub admin (Admin -> OAuth Clients)
- Node.js 18+

## Setup

### 1. Create OAuth Client in iHub

1. Go to iHub Admin -> OAuth Clients
2. Enable OAuth
3. Click "Create OAuth Client"
4. Set:
   - **Client Type**: `confidential` (or `public` for PKCE-only mode)
   - **Grant Types**: `authorization_code` and `refresh_token`
   - **Redirect URIs**: `http://localhost:8080/callback`
5. Save and note the **Client ID** and **Client Secret**

### 2. Configure This App

```bash
cd examples/oauth-client
cp .env.example .env
# Edit .env with your CLIENT_ID and CLIENT_SECRET
```

### 3. Install and Run

```bash
npm install
npm start
```

Open http://localhost:8080 and click "Login with iHub".

## Modes

### Confidential Mode (default)

Server-side app that uses a client secret. Recommended for backend applications that can securely store credentials.

```env
CLIENT_MODE=confidential
CLIENT_SECRET=your_secret_here
```

### Public Mode

SPA/mobile style: uses PKCE only, no client secret required. The client must be set to type `public` in iHub admin.

```env
CLIENT_MODE=public
# CLIENT_SECRET not needed
```

## Flow Walkthrough

1. **Login** - generates PKCE verifier + challenge, redirects to iHub `/api/oauth/authorize`
2. **iHub** - user logs in (if not already), consent screen is shown
3. **Callback** - receives authorization code, exchanges for tokens via `/api/oauth/token`
4. **Dashboard** - displays decoded token claims, with refresh and logout buttons

## Endpoints Demonstrated

| Endpoint | Description |
|---|---|
| `GET /api/oauth/authorize` | Start the authorization flow |
| `POST /api/oauth/token` | Exchange code for tokens, or refresh tokens |
| `GET /api/oauth/userinfo` | Fetch authenticated user profile |
| `POST /api/oauth/revoke` | Revoke refresh token on logout |
| `GET /.well-known/openid-configuration` | OIDC discovery document |
| `GET /.well-known/jwks.json` | Token signature verification keys |

## Security Notes

- PKCE is used in both modes (recommended by OAuth 2.1 for all clients)
- State parameter prevents CSRF attacks on the callback
- Nonce binds the ID token to this specific authentication request
- Refresh tokens are revoked on logout (RFC 7009)
- Raw token strings are never exposed to the browser via the session API
- The in-memory session store is for demonstration only; use a proper session store in production

## File Structure

```
examples/oauth-client/
├── .env.example        # Configuration template
├── package.json        # Dependencies and scripts
├── server.js           # Express server implementing the OAuth flow
└── public/
    ├── index.html      # Login page
    └── dashboard.html  # Post-login page showing token claims
```
