---
description: "Make iFinder trust iHub's per-user tokens: keyless OIDC signing (recommended), a shared OIDC provider, or a legacy manual key pair."
audience: admin
type: how-to
adminPage: /admin/integrations
---

# iFinder Authentication

iHub calls the iFinder and iAssistant APIs on behalf of the signed-in user. Every request carries a
short-lived JWT that identifies that user, and iFinder must be able to verify it. This page sets up
that trust on both sides. The rest of the integration is described in
[iFinder and iAssistant Integration](iFinder-Integration.md).

| Approach | Who signs the token | How iFinder verifies it | Key management |
| --- | --- | --- | --- |
| **Keyless (recommended)** | iHub, with its OIDC signing key (`useOidcKeyPair: true`) | Fetches iHub's public key from `/.well-known/jwks.json` | None |
| [Shared OIDC provider](#shared-oidc-provider-token-exchange) | The OIDC provider iHub and iFinder share (`authMode: "oidcTokenExchange"`) | Trusts the provider, as for its own logins | None |
| [Manual key pair (legacy)](#legacy-manual-key-exchange) | iHub, with a private key you generated | A public key you deployed into iFinder | Generate, distribute and rotate by hand |

> [!TIP]
> If iHub and iFinder already sign users in through the same OIDC provider (Zitadel, Keycloak,
> Entra ID), iFinder usually trusts that provider and nothing else. Use
> [Shared OIDC Provider (Token Exchange)](#shared-oidc-provider-token-exchange) then.

## Keyless setup

The keyless approach reuses the RSA key pair that iHub maintains for its OpenID Connect / OAuth
server. Its public half is published at the standard JWKS endpoint, the way any OIDC provider
publishes its signing keys. iFinder is a Spring Boot application and already knows how to consume
an OIDC provider's discovery and JWKS endpoints, so pointing it at iHub is all it takes.

- **Nothing to generate.** No `openssl`, no PEM files, no `IFINDER_PRIVATE_KEY`.
- **Nothing to exchange.** iFinder pulls the public key over HTTPS when it needs it.
- **Automatic rotation.** When iHub's signing key changes, iFinder picks up the new key from the
  JWKS endpoint (keys are matched by their `kid`).
- **Standards-based.** iFinder validates iHub tokens like tokens from Entra ID or Keycloak.
- **One key.** The same key signs iHub's own OIDC tokens, so there is one key to back up
  (`contents/.jwt-private-key.pem`).

### How it works

```mermaid
sequenceDiagram
    participant U as User (browser)
    participant H as iHub Apps
    participant F as iFinder / iAssistant

    Note over H: Signs with the iHub OIDC RSA private key
    U->>H: Uses an iFinder-backed app
    H->>H: Mint JWT for the user<br/>alg=RS256, kid=#lt;iHub key id#gt;,<br/>iss=#lt;iHub issuer URL#gt;, sub=#lt;user#gt;
    H->>F: API request + Authorization: Bearer #lt;JWT#gt;

    Note over F: First request only (then cached)
    F->>H: GET /.well-known/openid-configuration
    H-->>F: issuer, jwks_uri, ...
    F->>H: GET /.well-known/jwks.json
    H-->>F: Public key(s) with matching kid

    F->>F: Verify signature (JWKS) + iss + exp
    F-->>H: Search / RAG results (in user context)
    H-->>U: Answer
```

1. A user triggers an iFinder tool or an iAssistant conversation.
2. iHub mints a JWT for that user and signs it with its OIDC RSA private key (`RS256`). The header
   carries a `kid` that matches the key at iHub's JWKS endpoint; the `iss` claim is iHub's public
   base URL.
3. iHub sends the token in the `Authorization: Bearer …` header.
4. On the first token, iFinder reads iHub's discovery document, learns the `jwks_uri` and downloads
   the public keys. It caches them and refetches only for an unknown `kid`.
5. iFinder verifies the signature, checks that `iss` matches its `issuer-uri`, and checks expiry.

### Prerequisites

- **iHub reachable from iFinder** over HTTPS at a stable base URL; iFinder fetches `/.well-known/*`
  from it.
- **RS256 signing.** The JWKS endpoint publishes a key only while `jwt.algorithm` in
  `platform.json` is `RS256` (the default). If it was changed to `HS256`, switch it back first.
- **iFinder-side trust.** Ticking **Sign with iHub's OIDC key pair** changes only how iHub signs.
  Without [Step 2](#step-2-configure-ifinder), every request fails with `401` and an empty body
  (diagnostics step **API request**), which looks like an iHub problem but is not.
- **A matching identity.** iFinder must recognise the user identity iHub puts in `sub`.
- Admin access to iHub and to iFinder's Spring configuration.

You do not need to turn iHub into a full OAuth identity provider (`oauth.enabled`). The
`/.well-known/jwks.json` and `/.well-known/openid-configuration` endpoints are always served, and
the key pair is created on first start. The only OAuth setting that matters is the issuer URL.

### Step 1: Configure iHub Apps

1. Under **Admin → Authentication → OAuth Server**, set the issuer URL (`oauth.issuer`) to iHub's
   public base URL and restart the server (see the warning below).
2. Open **Admin → Integrations**, pick **iFinder** and **Install** (or **Edit** the installation).
3. Set the **iFinder base URL** and leave **Authentication** at *JWT signed by iHub*.
4. Tick **Sign with iHub's OIDC key pair**. The **Private key** field is not used and can stay
   empty.
5. Under the advanced settings, check **JWT audience** (default `ifinder-api`) and **Token scope**
   (`fa_index_read`). Set **User identity sent to iFinder** to what iFinder expects (usually
   `email`).
6. Click **Test**, then **Install** / **Save**.

While keyless mode is on, the private key, `IFINDER_PRIVATE_KEY`, the signing algorithm and the JWT
issuer field are ignored: the OIDC key, `RS256` and the OAuth issuer URL are used.

The same in the config files. The installation in `contents/config/integrations.json` reloads
automatically; `oauth.issuer` in `platform.json` needs a restart:

```json
{
  "installed": [
    {
      "id": "ifinder",
      "definition": "com.intrafind/ifinder",
      "enabled": true,
      "values": {
        "baseUrl": "https://ifinder.example.com",
        "authMode": "ihubSigned",
        "useOidcKeyPair": true,
        "audience": "ifinder-api",
        "defaultScope": "fa_index_read",
        "jwtSubjectField": "email",
        "tokenExpirationSeconds": 3600
      }
    }
  ]
}
```

```json
{
  "oauth": {
    "issuer": "https://ihub.example.com"
  }
}
```

> [!WARNING]
> **Set the OAuth issuer URL explicitly.** In keyless mode the token's `iss` comes from
> `oauth.issuer`. It must be an absolute URL (`http`/`https`) and identical to iFinder's
> `issuer-uri`. Tokens are signed outside any HTTP request, so iHub cannot detect its public host
> then; the "Auto-detected" issuer in the admin UI is used only for display and for the discovery
> document. If `oauth.issuer` is unset, `iss` falls back to the **JWT issuer** field (`ihub-apps`),
> which never matches, and iHub logs:
>
> ```
> iFinder useOidcKeyPair is enabled but platform.oauth.issuer is not a URL.
> iFinder JWT issuer will not match OIDC Discovery.
> ```
>
> Behind a reverse proxy, use the **external** URL that iFinder uses to reach iHub.

### Step 2: Configure iFinder

iFinder uses Spring Security's OAuth2 resource server. Point it at iHub's issuer:

```yaml
intrafind:
  security:
    auth:
      enable-oauth2-resource-server: true

spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          # Discovers /.well-known/openid-configuration and the JWKS from this URL.
          # Must match iHub's oauth.issuer exactly.
          issuer-uri: https://ihub.example.com
          # Which claim identifies the user. Match iHub's jwtSubjectField.
          principal-claim-name: email
```

| Property | Value | Purpose |
| --- | --- | --- |
| `intrafind.security.auth.enable-oauth2-resource-server` | `true` | Turn on JWT validation for API calls |
| `spring.security.oauth2.resourceserver.jwt.issuer-uri` | iHub public URL | Discover the keys and pin the issuer. Must be byte-for-byte identical to `oauth.issuer` (mind the trailing slash) |
| `spring.security.oauth2.resourceserver.jwt.principal-claim-name` | `email` (or your subject claim) | Which claim iFinder treats as the user name. For Entra ID-backed identities, `email` is the safe choice |

Instead of discovery you can point iFinder straight at the key set with
`spring.security.oauth2.resourceserver.jwt.jwk-set-uri: https://ihub.example.com/.well-known/jwks.json`.
Spring then checks signature and expiry but does not enforce the issuer by default, so
`issuer-uri` is preferred.

### Step 3: Verify the connection

1. Click **Test** on the iFinder installation (and the iAssistant installation) under
   **Admin → Integrations**. The **Issuer reachable** and **JWKS endpoint** steps show the URLs
   iFinder has to call back to. See
   [Testing the connection](iFinder-Integration.md#testing-the-connection).
2. From the iFinder host, check that iHub's endpoints are reachable and return a key:

   ```bash
   curl https://ihub.example.com/.well-known/openid-configuration
   curl https://ihub.example.com/.well-known/jwks.json
   ```

   The JWKS must contain a key with a `kid`. An empty `keys: []` means iHub is not signing with
   RS256.
3. On iFinder, turn on Spring Security debug logging while testing. A successful validation logs the
   resolved principal; signature, issuer and expiry failures are logged too.

   ```yaml
   logging:
     level:
       org.springframework.security: DEBUG
       org.springframework.security.oauth2: TRACE
   ```

### Token structure

```json
{
  "header": { "alg": "RS256", "typ": "JWT", "kid": "e67f5e39d283ddec" },
  "payload": {
    "sub": "user.email@example.com",
    "name": "User Name",
    "iat": 1643723400,
    "exp": 1643727000,
    "iss": "https://ihub.example.com",
    "aud": "ifinder-api",
    "scope": "fa_index_read"
  }
}
```

Compared with the legacy token, keyless mode adds the `kid` header and sets `iss` to the issuer URL
instead of `ihub-apps`. The same token is used for the iFinder tools and iAssistant.

### Configuration reference

| Setting | Where | Purpose | Required for keyless |
| --- | --- | --- | --- |
| `enabled` | installation switch | Turns the integration on | Yes |
| `baseUrl` | installation values | iFinder URL | Yes |
| `useOidcKeyPair` | installation values (**Sign with iHub's OIDC key pair**) | Sign with the iHub OIDC key, advertised via JWKS | Yes, `true` |
| `oauth.issuer` | `platform.json` (**Admin → Authentication → OAuth Server**) | Absolute URL stamped into `iss`; must equal iFinder's `issuer-uri` | Yes, a URL |
| `audience` | installation values, advanced | `aud` claim (default `ifinder-api`) | Optional |
| `defaultScope` | installation values, advanced (**Token scope**) | `scope` claim (default `fa_index_read`) | Optional |
| `jwtSubjectField` | installation values (**User identity sent to iFinder**) | Which user field becomes `sub`: `email`, `username`, `id`, `name`, `domain\username`, or a `${user.field}` template | Recommended |
| `tokenExpirationSeconds` | installation values, advanced | Token lifetime (default `3600`) | Optional |
| `jwt.algorithm` | `platform.json` | Must be `RS256` (default) so the JWKS has a key | Yes (default) |

### Troubleshooting the keyless setup

| Symptom | Cause and fix |
| --- | --- |
| "Invalid issuer", token rejected | `iss` must equal iFinder's `issuer-uri`. `oauth.issuer` unset (so `iss` is `ihub-apps`), a trailing-slash mismatch, or an internal host behind a reverse proxy. Use the same external URL on both sides and restart iHub |
| JWKS returns `{ "keys": [] }` | iHub is not signing with RS256. Set `jwt.algorithm` back to `RS256` and restart; HS256 keys cannot be published |
| "Unable to find a signing key", unknown `kid` | iFinder's cached key set is stale, or iHub's keys were regenerated. iFinder refreshes on an unknown `kid`; otherwise restart iFinder. Losing or regenerating `contents/.jwt-private-key.pem` invalidates all issued tokens |
| iFinder cannot reach `/.well-known/*` | Check network and TLS from the iFinder host (`curl -v https://ihub.example.com/.well-known/openid-configuration`). Firewalls, split-horizon DNS or a proxy that rewrites `Host` are the usual culprits |
| 401 with an empty body | iFinder does not trust iHub yet: do [Step 2](#step-2-configure-ifinder) |
| Wrong user resolved in iFinder | `principal-claim-name` must match what iHub sends via `jwtSubjectField` |
| *iFinder JWT requires authenticated user* | The user is anonymous; unrelated to the signing mode |

## Shared OIDC Provider (Token Exchange)

When iHub and iFinder already sign users in through the **same OIDC provider**, iFinder usually
trusts that provider only, and adding iHub as a second issuer conflicts with its own logins. In the
**`oidcTokenExchange`** mode the provider issues the iFinder token.

| | `ihubSigned` (default) | `oidcTokenExchange` |
| --- | --- | --- |
| Who issues the iFinder token | iHub (private key or OIDC key pair) | The shared OIDC provider |
| iFinder `issuer-uri` | iHub (`oauth.issuer`) or the key you deployed | The provider |
| `sub` in the token | The installation's `jwtSubjectField` | The provider's user claim, the same iFinder sees for its own logins |
| `fa_*` claims | `scope` claim set by iHub | Scopes iHub requests, or added by a claim mapper on the provider |
| Who can use iFinder | Every signed-in user | Users who signed in to iHub through that provider |

### How token exchange works

1. **Sign-in.** When a user signs in to iHub through the selected provider, iHub keeps the
   provider's access and refresh token, encrypted (AES-256-GCM) in `contents/integrations/oidc-login/`.
   They are never written to `users.json`. Sign-ins through other providers store nothing.
2. **Per iFinder call.** iHub exchanges the stored access token at the provider's token endpoint for
   a token with the iFinder audience and scopes, and caches it per user, audience and scope until one
   minute before it expires.
3. **Expiry.** An expired sign-in token is refreshed with the refresh token first. Cluster workers
   take a per-user lock for the refresh, because Zitadel and Keycloak rotate refresh tokens.
4. **Background runs.** Scheduled tasks, personal API keys and workflows have no session and use the
   stored refresh token. **Add `offline_access` to the provider's scopes** (**Admin →
   Authentication → OIDC provider → Scopes**), otherwise iFinder access ends when the sign-in token
   expires.

The stored tokens survive logout, so scheduled tasks keep running. They are deleted when the user
is deleted or deactivated, when the user revokes them under **Integrations** in their profile, and
when the provider rejects the refresh token for good. Users who did not sign in through the selected
provider (local, LDAP, NTLM, another OIDC provider) cannot use iFinder; there is no fallback to
iHub-signed tokens.

### Configure iHub

In the iFinder installation (**Admin → Integrations → iFinder**, **Edit**), set **Authentication**
to *OIDC token exchange*, then:

| Field | Installation value | Purpose |
| --- | --- | --- |
| OIDC provider for token exchange | `tokenExchangeProvider` | Name of the provider under **Admin → Authentication** that iFinder shares |
| Token exchange grant | `tokenExchangeGrant` | `tokenExchange` (RFC 8693: Zitadel, Keycloak) or `entraObo` (Entra On-Behalf-Of) |
| Token exchange audience | `tokenExchangeAudience` | iFinder's client or project id at the provider (RFC 8693 only) |
| Provider scope for `fa_index_read`, `fa_iassistant`, `fi_smartcollections` | `tokenExchangeScopeIndexRead`, `tokenExchangeScopeAssistant`, `tokenExchangeScopeSmartCollections` | Map the scopes iHub asks for (`fa_index_read` for search, `fa_iassistant` for iAssistant, `fi_smartcollections` for Smart Collections, the **Token scope** otherwise) to provider scopes. Empty sends the scope unchanged |
| Extra scopes for the exchange | `tokenExchangeExtraScopes` | A list sent with every exchange |

All but the provider are advanced settings:

```json
{
  "id": "ifinder",
  "definition": "com.intrafind/ifinder",
  "enabled": true,
  "values": {
    "baseUrl": "https://ifinder.example.com",
    "defaultScope": "fa_index_read",
    "authMode": "oidcTokenExchange",
    "tokenExchangeProvider": "zitadel",
    "tokenExchangeGrant": "tokenExchange",
    "tokenExchangeAudience": "312345678901234567",
    "tokenExchangeScopeIndexRead": "",
    "tokenExchangeScopeAssistant": "",
    "tokenExchangeScopeSmartCollections": "",
    "tokenExchangeExtraScopes": []
  }
}
```

The key, issuer, algorithm, lifetime and **User identity sent to iFinder** settings do not apply in
this mode. No new credentials are needed: iHub refreshes and exchanges with the client id and secret
configured for the provider under **Admin → Authentication**, so that client must be allowed to
exchange for the iFinder audience and to use `client_secret_post` (id and secret in the form body).
The token endpoint is called through iHub's proxy and SSL settings, so a provider with a private CA
works once its host is in `ssl.domainWhitelist`.

### Configure iFinder

Point iFinder at the provider, the same issuer it already uses for its own logins:

```yaml
intrafind.security.auth.enable-oauth2-resource-server: true
spring.security.oauth2.resourceserver.jwt.issuer-uri: https://<provider issuer>
```

| Provider | `issuer-uri` |
| --- | --- |
| Zitadel | `https://<instance>.zitadel.cloud` (or your custom domain) |
| Keycloak | `https://<host>/realms/<realm>` |
| Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |

Extra claims in the provider's token are harmless. The token must also carry the `fa_*` claims
iFinder reads, either as scopes iHub requests (scope map) or added by a claim mapper on the provider
for the iFinder audience. To switch without downtime, let iFinder accept both issuers (iHub and the
provider) first, then switch iHub's mode.

### Provider setup

**Zitadel**

1. Enable token exchange for the instance (a beta feature): `PUT /v2/features/instance` with
   `"oidcTokenExchange": true`, or the instance's feature settings in the console.
2. Make the iHub application a confidential web application (client secret). Enable the *Token
   Exchange* grant, and the *Refresh Token* grant for `offline_access`.
3. Set the audience to iFinder's project id, and request project roles through Zitadel's reserved
   scopes, for example in **Additional scopes**:
   `urn:zitadel:iam:org:project:id:<ifinder-project-id>:aud` and
   `urn:zitadel:iam:org:projects:roles`. Map the `fa_*` roles into the claim iFinder reads with an
   Action if they are not already there.
4. Add `offline_access` to the provider's sign-in scopes in iHub.

**Keycloak 26.2 or later**

1. On the iHub client (confidential, *Client authentication* on), enable **Standard token
   exchange** under *Capability config*.
2. Allow the iHub client to exchange for the iFinder client: add the iFinder client as an audience
   (an *audience* mapper or a client scope), and set **Token exchange audience** in iHub to the
   iFinder client id.
3. Make the `fa_*` values available as client scopes iHub requests through the scope map, or as
   roles mapped into the token by a protocol mapper.
4. Add `offline_access` to the provider's sign-in scopes in iHub. Keycloak rotates refresh tokens
   when *Revoke refresh token* is on; iHub handles that.

Keycloak's standard token exchange supports only internal-to-internal exchange, and the subject
token must be an access token, which is what iHub sends.

**Microsoft Entra ID (On-Behalf-Of)**

Entra does not support RFC 8693; choose the grant **Microsoft Entra on-behalf-of**.

1. Expose an API on the iHub app registration (for example
   `api://<ihub-client-id>/access_as_user`). Add that scope to the provider's sign-in scopes in iHub,
   together with `openid profile email offline_access`. Without it the sign-in returns a Microsoft
   Graph token, which On-Behalf-Of rejects.
2. Expose an API on the iFinder app registration and give the iHub registration an API permission
   for it, with admin consent.
3. Set **Provider scope for `fa_index_read`** (and for `fa_iassistant`) to
   `api://<ifinder-app-id>/.default`. Audience is not used.
4. Provide the `fa_*` claims as app roles of the iFinder app registration assigned to users or
   groups, or as optional claims.

### Verify the token exchange

**Test** on the iFinder installation runs the exchange for your own account (you must have signed
in through the selected provider), decodes the token without verifying it, and shows `iss`, `aud`,
`sub`, the scope claim and which expected `fa_*` claims are present. It then calls the iFinder
search API with that token.

Users see the stored authorization under **Integrations** in their profile, with the date it was
granted and a button to revoke it.

### Token exchange errors

| Message | Cause |
| --- | --- |
| *iFinder requires sign-in via &lt;provider&gt;* | The user signed in some other way. Sign in through the selected provider |
| *Sign in again via &lt;provider&gt; to re-authorize iFinder access* | No stored token (signed in before the mode was switched on, revoked, deactivated) or the refresh token was rejected. Signing in once restores it |
| *&lt;provider&gt; refused the iFinder token exchange (HTTP 400): …* | The provider's exchange policy: token exchange not enabled, client not allowed for the audience, scope not granted, or (Entra) a Graph token as assertion |
| *The sign-in provider &lt;provider&gt; is temporarily unavailable* | The refresh failed for a temporary reason (network, 5xx); the stored tokens are kept |
| Diagnostics: *The token does not carry fa_…* | Request the claim through the scope map or add it with a claim mapper |

## Legacy: manual key exchange

> [!NOTE]
> Use this only if you must sign iFinder tokens with a dedicated, manually managed key. The
> [keyless setup](#keyless-setup) needs no key at all.

You generate a key pair, give the private key to iHub, and deploy the public key into iFinder. The
default algorithm is `RS256`; the installation's **Signing algorithm** also offers RS384, RS512 and
ES256/384/512 (the ES\* algorithms need an EC key instead of RSA).

### Generate the key pair

You need OpenSSL.

1. Generate a 2048-bit RSA private key (use `4096` for more security):

   ```bash
   openssl genpkey -algorithm RSA -out ifinder_private.pem -pkeyopt rsa_keygen_bits:2048
   ```

2. Extract the public key:

   ```bash
   openssl pkey -in ifinder_private.pem -pubout -out ifinder_public.pem
   ```

3. Check both. The private key starts with `-----BEGIN PRIVATE KEY-----`, the public key with
   `-----BEGIN PUBLIC KEY-----`:

   ```bash
   openssl pkey -in ifinder_private.pem -text -noout
   openssl pkey -in ifinder_public.pem -pubin -text -noout
   head -1 ifinder_private.pem ifinder_public.pem
   ```

4. Check that the two belong together; the last command prints `Verified OK`:

   ```bash
   echo "test message" > test.txt
   openssl dgst -sha256 -sign ifinder_private.pem -out test.sig test.txt
   openssl dgst -sha256 -verify ifinder_public.pem -signature test.sig test.txt
   ```

Keep the private key secret: restrict its file permissions (`chmod 600`), never commit it, and
delete the local copy once it is stored in iHub.

### Give the private key to iHub

Use one of these; the environment variable wins when both are set.

**Credential (recommended).**

1. Open **Admin → Credentials** and create a credential of type **Secret** with the full contents
   of `ifinder_private.pem`, including the `BEGIN`/`END` lines. It is encrypted at rest.
2. Open **Admin → Integrations → iFinder** (**Install** or **Edit**), leave **Sign with iHub's OIDC
   key pair** unticked, and pick that credential in **Private key** (stored as `privateKeyRef`).
3. Save. No restart is needed; the key is read from the credential store on every signing.

**Environment variable.**

```bash
export IFINDER_PRIVATE_KEY="$(cat ifinder_private.pem)"
```

Restart the server after setting it. Real newlines and `\n` escapes both work. There is no
`IFINDER_PRIVATE_KEY_FILE`.

All instances of a multi-instance iHub deployment must use the same key.

### Configure iFinder with the public key

Point iFinder's Spring Security at the public key:

```yaml
intrafind:
  security:
    auth:
      enable-oauth2-resource-server: true

spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          public-key-location: classpath:ifinder_public.pem
          principal-claim-name: email # or sub, preferred_username, upn
```

`public-key-location` accepts:

- `classpath:ifinder_public.pem`: from the application classpath
- `file:/path/to/ifinder_public.pem`: from the file system
- `https://example.com/keys/public.pem`: from an HTTPS URL
- `base64:LS0tLS1CRUdJTi...`: Base64-encoded key content
- `text:-----BEGIN PUBLIC KEY-----...`: inline key content

For Microsoft Entra ID-backed identities, use `email` as the principal claim.

### Legacy token structure

```json
{
  "header": { "alg": "RS256", "typ": "JWT" },
  "payload": {
    "sub": "user.email@example.com",
    "name": "User Name",
    "iat": 1643723400,
    "exp": 1643727000,
    "iss": "ihub-apps",
    "aud": "ifinder-api",
    "scope": "fa_index_read"
  }
}
```

The claims are fixed; custom claims are not supported. You can tune them with the installation's
advanced fields: **JWT issuer** (`issuer`), **JWT audience** (`audience`), **Token scope**
(`defaultScope`), **Token lifetime** (`tokenExpirationSeconds`), **Signing algorithm**
(`algorithm`) and **User identity sent to iFinder** (`jwtSubjectField`, the `sub` claim).

### Rotate the key

Rotate every 6 to 12 months, or at once if the key may be compromised:

1. Generate a new pair as above.
2. Deploy the new public key into iFinder.
3. Replace the credential value (or `IFINDER_PRIVATE_KEY`, then restart).
4. Run **Test**.

Because iHub and iFinder must switch together, consider [migrating to keyless](#migrating-from-manual-key-exchange)
instead: it rotates without touching iFinder.

### Troubleshooting the key pair

| Problem | Fix |
| --- | --- |
| Signature verification fails, or *iFinder authentication failed. Please check JWT configuration.* | Public and private key do not match: run the `Verified OK` check above. Check the algorithm matches the key type (RS\* for RSA, ES\* for EC) |
| *iFinder private key must be in PEM format* | The key must start with `-----BEGIN PRIVATE KEY-----`; no BOM or extra characters. Regenerate with the commands above if in doubt |
| *iFinder private key not configured* | No credential picked and no `IFINDER_PRIVATE_KEY` set |
| iFinder rejects the token | The public key is not where `public-key-location` points, iFinder cannot read it, or `principal-claim-name` does not match the claims |
| Token expired | Synchronise the clocks of iHub and iFinder; raise **Token lifetime** if needed |

To decode a token by hand, use a local tool. Never paste production tokens or keys into an online
JWT debugger.

### Migrating from manual key exchange

1. **iHub:** set `oauth.issuer` to the public URL, then tick **Sign with iHub's OIDC key pair** in
   the iFinder installation and save. The old **Private key** credential (or `IFINDER_PRIVATE_KEY`)
   can stay; it is ignored while keyless mode is on.
2. **iFinder:** replace `public-key-location` with `issuer-uri` (or `jwk-set-uri`) as in
   [Step 2](#step-2-configure-ifinder).
3. **Restart** iFinder and iHub (`oauth.issuer` needs a restart), then run **Test**.
4. Once it works, remove the old public key from iFinder and the credential or
   `IFINDER_PRIVATE_KEY` from iHub.

> [!IMPORTANT]
> The two mechanisms are mutually exclusive: while `useOidcKeyPair` is `true`, the manual key is not
> used. Switch iHub and iFinder together.

## Related documentation

- [iFinder and iAssistant Integration](iFinder-Integration.md): setup, tools, UI and troubleshooting
- [Using iHub as an OIDC Identity Provider](ihub-as-oidc-idp.md): the same JWKS and discovery
  endpoints for other clients
- [JWT Well-Known Endpoints](jwt-well-known-endpoints.md): JWKS and discovery details, key
  management
