# Using iHub as an OIDC Identity Provider

This guide explains how to configure external frameworks and libraries to authenticate users through iHub Apps acting as an OpenID Connect (OIDC) Identity Provider.

## Table of Contents

1. [What iHub Exposes as an OIDC IdP](#what-ihub-exposes-as-an-oidc-idp)
2. [Discovery Endpoint](#discovery-endpoint)
3. [JWKS Endpoint](#jwks-endpoint)
4. [Issuer Configuration](#issuer-configuration)
5. [Configuring OIDC Clients](#configuring-oidc-clients)
   - [Generic Setup Steps](#generic-setup-steps)
   - [Node.js with openid-client](#nodejs-with-openid-client)
   - [Node.js with Passport.js](#nodejs-with-passportjs)
   - [Python with Authlib](#python-with-authlib)
   - [Spring Boot Resource Server](#spring-boot-resource-server)
   - [ASP.NET Core](#aspnet-core)
6. [Claims Reference](#claims-reference)
7. [Supported Scopes and Response Types](#supported-scopes-and-response-types)
8. [Token Validation](#token-validation)
9. [Troubleshooting](#troubleshooting)

## What iHub Exposes as an OIDC IdP

iHub Apps implements a subset of the OpenID Connect Core 1.0 specification, making it usable as an IdP for external applications. The following capabilities are available:

| Capability | Supported |
|---|---|
| Authorization Code Flow | Yes |
| Authorization Code Flow with PKCE | Yes (S256 method) |
| Client Credentials Flow | Yes |
| Implicit Flow | No |
| Hybrid Flow | No |
| ID Token (RS256) | Yes |
| Access Token (RS256) | Yes |
| Refresh Tokens | Yes |
| UserInfo Endpoint | Yes |
| OIDC Discovery | Yes |
| JWKS Endpoint | Yes |
| Token Revocation | Yes |
| Token Introspection | Yes |

All tokens are signed with RS256 (RSA + SHA-256). The public key is accessible via the JWKS endpoint, enabling external services to validate tokens without contacting iHub at request time.

## Discovery Endpoint

The OIDC Discovery document is available at:

```
GET /.well-known/openid-configuration
```

Example request:

```bash
curl https://your-ihub-instance.com/.well-known/openid-configuration
```

Example response:

```json
{
  "issuer": "https://your-ihub-instance.com",
  "authorization_endpoint": "https://your-ihub-instance.com/api/oauth/authorize",
  "token_endpoint": "https://your-ihub-instance.com/api/oauth/token",
  "userinfo_endpoint": "https://your-ihub-instance.com/api/oauth/userinfo",
  "jwks_uri": "https://your-ihub-instance.com/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "token_endpoint_auth_methods_supported": [
    "client_secret_post",
    "client_secret_basic"
  ],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "client_credentials"
  ],
  "scopes_supported": ["openid", "profile", "email", "offline_access"],
  "claims_supported": ["sub", "name", "email", "groups"],
  "code_challenge_methods_supported": ["S256"]
}
```

Most OIDC client libraries can auto-configure themselves from this discovery document using only the `issuer` URL.

## JWKS Endpoint

The JSON Web Key Set endpoint provides the public key used to verify RS256 tokens:

```
GET /.well-known/jwks.json
```

Example response:

```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "w_7VjVZ3eoM8...",
      "e": "AQAB",
      "use": "sig",
      "kid": "e67f5e39d283ddec",
      "alg": "RS256"
    }
  ]
}
```

External services should cache this response and refresh it only when they encounter a `kid` they do not recognise. Most OIDC libraries handle JWKS caching automatically.

> The JWKS endpoint is only populated when the JWT algorithm is RS256 (the default). If HS256 is configured, the endpoint returns an empty keys array. See [JWT Well-Known Endpoints](jwt-well-known-endpoints.md) for more on key management.

## Issuer Configuration

The `issuer` value in tokens and the discovery document is the base URL of the iHub server. It is derived automatically from the server's host and protocol.

You can override it explicitly in `contents/config/platform.json`:

```json
{
  "oauth": {
    "enabled": true,
    "issuer": "https://your-ihub-instance.com"
  }
}
```

Set this when iHub is deployed behind a reverse proxy and the derived URL would be wrong (e.g., when the internal hostname differs from the public hostname).

**Important:** The issuer value in every token issued by iHub must match the `issuer` you configure in your OIDC client library. A mismatch causes token validation to fail.

## Configuring OIDC Clients

### Generic Setup Steps

Regardless of the library you use, the steps are the same:

1. **Register an OAuth client in iHub** — use the admin API or admin UI. For user login flows, you need at minimum `"grantTypes": ["authorization_code"]` and a registered `redirect_uri`.

2. **Obtain the discovery URL** — it is `https://your-ihub-instance.com/.well-known/openid-configuration`.

3. **Configure your library** with:
   - The discovery URL or the `issuer` URL
   - Your `client_id`
   - Your `client_secret` (for confidential clients)
   - Your `redirect_uri`
   - The scopes you need

4. **Verify the `id_token`** using the JWKS endpoint, checking that `iss`, `aud`, and `exp` are correct.

---

### Node.js with openid-client

[openid-client](https://github.com/panva/node-openid-client) is the most complete OIDC client for Node.js. It auto-discovers configuration from the discovery endpoint.

```bash
npm install openid-client
```

```javascript
import { Issuer, generators } from 'openid-client';
import express from 'express';
import session from 'express-session';

const app = express();
app.use(session({ secret: 'session-secret', resave: false, saveUninitialized: false }));

// Auto-discover iHub's OIDC configuration
const ihubIssuer = await Issuer.discover('https://your-ihub-instance.com');

const client = new ihubIssuer.Client({
  client_id: 'your_client_id',
  // client_secret: 'your_secret',  // Only for confidential clients
  redirect_uris: ['http://localhost:4000/auth/callback'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'  // Use 'client_secret_post' for confidential clients
});

/**
 * Initiate login — generate PKCE and state, then redirect to iHub.
 */
app.get('/login', (req, res) => {
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const nonce = generators.nonce();

  req.session.oidc = { codeVerifier, state, nonce };

  const authUrl = client.authorizationUrl({
    scope: 'openid profile email offline_access',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  res.redirect(authUrl);
});

/**
 * Handle the callback from iHub, exchange code for tokens.
 */
app.get('/auth/callback', async (req, res) => {
  const params = client.callbackParams(req);
  const { codeVerifier, state, nonce } = req.session.oidc;

  const tokenSet = await client.callback(
    'http://localhost:4000/auth/callback',
    params,
    { code_verifier: codeVerifier, state, nonce }
  );

  // tokenSet.id_token, tokenSet.access_token, tokenSet.refresh_token are now available
  const userInfo = await client.userinfo(tokenSet.access_token);

  req.session.user = userInfo;
  req.session.accessToken = tokenSet.access_token;
  req.session.refreshToken = tokenSet.refresh_token;
  delete req.session.oidc;

  res.redirect('/dashboard');
});

app.listen(4000);
```

---

### Node.js with Passport.js

Use `passport-openidconnect` for Passport.js integration.

```bash
npm install passport passport-openidconnect express-session
```

```javascript
import passport from 'passport';
import { Strategy as OIDCStrategy } from 'passport-openidconnect';
import express from 'express';
import session from 'express-session';

const app = express();
app.use(session({ secret: 'session-secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  'ihub',
  new OIDCStrategy(
    {
      issuer: 'https://your-ihub-instance.com',
      authorizationURL: 'https://your-ihub-instance.com/api/oauth/authorize',
      tokenURL: 'https://your-ihub-instance.com/api/oauth/token',
      userInfoURL: 'https://your-ihub-instance.com/api/oauth/userinfo',
      clientID: 'your_client_id',
      clientSecret: 'your_client_secret',  // confidential client
      callbackURL: 'http://localhost:4000/auth/callback',
      scope: ['openid', 'profile', 'email']
    },
    (issuer, profile, done) => {
      // profile contains id, displayName, emails, etc.
      return done(null, { id: profile.id, name: profile.displayName });
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.get('/login', passport.authenticate('ihub'));

app.get(
  '/auth/callback',
  passport.authenticate('ihub', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/dashboard')
);

app.get('/dashboard', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login');
  res.send(`Hello, ${req.user.name}`);
});

app.listen(4000);
```

---

### Python with Authlib

[Authlib](https://authlib.org/) is a comprehensive OAuth/OIDC library for Python.

```bash
pip install authlib requests flask
```

```python
from flask import Flask, redirect, url_for, session, request
from authlib.integrations.flask_client import OAuth
import os

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'dev-secret')

oauth = OAuth(app)

ihub = oauth.register(
    name='ihub',
    # Auto-discover all endpoints from the discovery document
    server_metadata_url='https://your-ihub-instance.com/.well-known/openid-configuration',
    client_id=os.environ['IHUB_CLIENT_ID'],
    client_secret=os.environ['IHUB_CLIENT_SECRET'],
    client_kwargs={
        'scope': 'openid profile email offline_access',
        'token_endpoint_auth_method': 'client_secret_post',
        'code_challenge_method': 'S256',  # Enables PKCE automatically
    }
)


@app.route('/login')
def login():
    redirect_uri = url_for('auth_callback', _external=True)
    return ihub.authorize_redirect(redirect_uri)


@app.route('/auth/callback')
def auth_callback():
    token = ihub.authorize_access_token()
    user_info = token.get('userinfo')
    if user_info:
        session['user'] = dict(user_info)
    return redirect('/dashboard')


@app.route('/dashboard')
def dashboard():
    user = session.get('user')
    if not user:
        return redirect('/login')
    return f"Hello, {user.get('name')}! Groups: {user.get('groups', [])}"


if __name__ == '__main__':
    app.run(port=4000)
```

---

### Spring Boot Resource Server

To validate iHub-issued access tokens in a Spring Boot application (without login flow — just token verification):

```yaml
# application.yml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://your-ihub-instance.com
          jwk-set-uri: https://your-ihub-instance.com/.well-known/jwks.json
```

```java
// SecurityConfig.java
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/public/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .jwkSetUri("https://your-ihub-instance.com/.well-known/jwks.json")
                )
            );
        return http.build();
    }
}
```

To initiate the login flow (Authorization Code) in a Spring Boot web application:

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          ihub:
            client-id: your_client_id
            client-secret: your_client_secret
            authorization-grant-type: authorization_code
            redirect-uri: "{baseUrl}/login/oauth2/code/ihub"
            scope: openid, profile, email
        provider:
          ihub:
            issuer-uri: https://your-ihub-instance.com
```

---

### ASP.NET Core

Configure JWT bearer authentication to validate iHub access tokens:

```csharp
// Program.cs
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // Auto-configure from discovery document
        options.Authority = "https://your-ihub-instance.com";
        options.Audience = "your_client_id";
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true
        };
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/protected", (HttpContext ctx) =>
    Results.Ok(new { user = ctx.User.Identity?.Name }))
    .RequireAuthorization();

app.Run();
```

For the full login flow (Authorization Code):

```csharp
builder.Services.AddAuthentication(options =>
{
    options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = OpenIdConnectDefaults.AuthenticationScheme;
})
.AddCookie()
.AddOpenIdConnect(options =>
{
    options.Authority = "https://your-ihub-instance.com";
    options.ClientId = "your_client_id";
    options.ClientSecret = "your_client_secret";
    options.ResponseType = "code";
    options.Scope.Add("openid");
    options.Scope.Add("profile");
    options.Scope.Add("email");
    options.UsePkce = true;
    options.SaveTokens = true;
    options.CallbackPath = "/auth/callback";
});
```

## Claims Reference

Claims available in tokens and from the UserInfo endpoint:

| Claim | Scope Required | Description |
|---|---|---|
| `sub` | `openid` | Subject identifier (user ID) |
| `iss` | `openid` | Issuer (iHub base URL) |
| `aud` | `openid` | Audience (your client ID) |
| `iat` | `openid` | Issued-at time (Unix timestamp) |
| `exp` | `openid` | Expiration time (Unix timestamp) |
| `name` | `profile` | User's display name |
| `email` | `email` | User's email address |
| `groups` | `profile` | Array of iHub group names the user belongs to |
| `nonce` | `openid` (ID token only) | Nonce value from authorization request |

The `groups` claim contains the user's resolved group memberships in iHub, including inherited groups. You can use this claim in your application to make authorization decisions based on the user's iHub role.

## Supported Scopes and Response Types

**Scopes:**

| Scope | Description |
|---|---|
| `openid` | Required for OIDC; includes `sub`, `iss`, `aud`, `iat`, `exp` |
| `profile` | Includes `name`, `groups` |
| `email` | Includes `email` |
| `offline_access` | Requests a refresh token |

**Response types:**

| Response Type | Description |
|---|---|
| `code` | Authorization Code Flow (only supported type) |

## Token Validation

When an external service receives a token issued by iHub, it should validate:

1. **Signature** — verify using the JWKS endpoint (`/.well-known/jwks.json`)
2. **Issuer** (`iss`) — must match your iHub instance URL
3. **Audience** (`aud`) — must match your `client_id`
4. **Expiration** (`exp`) — must be in the future
5. **Algorithm** (`alg` in token header) — must be `RS256`
6. **Key ID** (`kid` in token header) — must match a key in the JWKS

Most OIDC libraries perform all of these checks automatically when you provide the `issuer` and `audience` values.

### Manual validation example with jose

```javascript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL('https://your-ihub-instance.com/.well-known/jwks.json')
);

/**
 * Validate an RS256-signed JWT issued by iHub.
 *
 * @param {string} token - The JWT string to validate.
 * @param {string} clientId - The expected audience (your OAuth client ID).
 * @returns {Promise<Object>} The decoded JWT payload if valid.
 * @throws {Error} If the token is invalid, expired, or has wrong issuer/audience.
 */
async function validateIHubToken(token, clientId) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: 'https://your-ihub-instance.com',
    audience: clientId,
    algorithms: ['RS256']
  });
  return payload;
}
```

## Troubleshooting

### "Invalid issuer" errors

The `iss` claim in the token must exactly match the value you configure in your OIDC library. Common mismatches:

- iHub is behind a reverse proxy that rewrites `Host` headers, so the auto-derived issuer differs from the public URL. Fix: set `platform.oauth.issuer` explicitly in `platform.json`.
- A trailing slash difference: `https://example.com` vs `https://example.com/`.

### "Invalid audience" errors

The `aud` claim equals the `clientId` of the OAuth client that was used to obtain the token. Your OIDC library must be configured with the same `clientId` as the audience.

### "Unable to find a signing key" / JWKS errors

The token's `kid` (key ID) in the JWT header must match a key in `/.well-known/jwks.json`. This fails if:

- The iHub server's RSA keys were regenerated after the token was issued
- The JWKS cache in your OIDC library is stale — force a refresh

### Discovery document returns 404

The `/.well-known/openid-configuration` endpoint requires OAuth to be enabled (`platform.oauth.enabled: true`) and the server to be restarted after enabling it.

### "client_id not found" errors

Ensure the OAuth client is created in iHub and `active: true`. Clients can be managed via the iHub Admin UI under "OAuth Clients" or via the admin API.

## Related Documentation

- [OAuth Authorization Code Flow](oauth-authorization-code.md) — full developer reference for the Authorization Code Flow
- [JWT Well-Known Endpoints](jwt-well-known-endpoints.md) — JWKS and discovery endpoint details, key management
- [OAuth Integration Guide (Client Credentials)](oauth-integration-guide.md) — machine-to-machine API access
- [External Authentication](external-authentication.md) — iHub authentication modes overview

---

_Last updated: February 2026_
