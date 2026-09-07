# Personal API Keys

> **Note:** Personal API keys are user-owned credentials that act as the user who created them.
> For machine-to-machine service accounts, see the
> [OAuth Integration Guide](oauth-integration-guide.md). For user login from an external app,
> see [OAuth Authorization Code Flow](oauth-authorization-code.md).

Personal API keys let a signed-in user generate credentials for themselves under
**Settings → Integrations**, without asking an administrator to create a service account.

A call made with a personal key is authorized exactly as if the owner made it from the web UI:
the same apps, the same models, the same prompts. A key can never do more than its owner can, and
it never carries admin access — even when the owner is an administrator.

## Table of Contents

1. [How it works](#how-it-works)
2. [Enabling the feature](#enabling-the-feature)
3. [Creating a key](#creating-a-key)
4. [Using a key](#using-a-key)
5. [Rotating and revoking](#rotating-and-revoking)
6. [Administration](#administration)
7. [Security model](#security-model)

## How it works

Each personal key is backed by an entry in `contents/config/oauth-clients.json` marked
`personal: true` and carrying an owner snapshot (user ID, display name, e-mail, groups).

Two kinds of credential are issued from that entry:

| Credential                     | What it is                                             | Where it is used                              |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------- |
| **API key**                    | A long-lived bearer token                              | `Authorization: Bearer <api key>` on any call |
| **Client ID + client secret**  | OAuth 2.0 client credentials for the same personal key | `POST /api/oauth/token` for a short-lived token |

Both authenticate as the owner (`authMode: oauth_personal_key`). The token itself carries no
identity beyond the subject: the acting user's name, e-mail and groups are resolved from the client
record on every request, so revoking a key, suspending it, or turning the feature off takes effect
immediately rather than when the token happens to expire.

## Enabling the feature

Personal keys are off by default and require the OAuth client store, because that is where they are
stored.

1. Go to **Admin → OAuth → Clients** and enable OAuth clients.
2. Go to **Admin → OAuth → Authorization Server** and turn on **Personal API Keys**.
3. Set the limits that suit your deployment.

The equivalent configuration in `contents/config/platform.json`:

```json
{
  "oauth": {
    "enabled": { "authz": true, "clients": true },
    "personalKeys": {
      "enabled": true,
      "allowedGroups": [],
      "maxKeysPerUser": 5,
      "defaultExpirationDays": 90,
      "maxExpirationDays": 365,
      "allowClientCredentials": true,
      "scopes": []
    }
  }
}
```

| Field                    | Meaning                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `enabled`                | Offer personal keys at all. Turning this off stops every existing key from working.          |
| `allowedGroups`          | Group IDs allowed to create keys. Empty means every signed-in user may.                      |
| `maxKeysPerUser`         | How many keys one user may hold at once (1–100).                                             |
| `defaultExpirationDays`  | Lifetime used when the user does not choose one.                                             |
| `maxExpirationDays`      | Upper bound the user cannot exceed (1–3650).                                                 |
| `allowClientCredentials` | Also hand out a client ID and secret for the token endpoint. Turning it off stops existing keys from using theirs, too. |
| `scopes`                 | Scopes stamped on each key. Empty falls back to `mcpServer.defaultScopes`.                   |

`oauth.enabled.authz` is what makes the token endpoint available; without it the client ID and
secret are still issued but cannot be exchanged, so leave it on when `allowClientCredentials`
is on.

Anonymous users can never create keys, even where anonymous access is enabled platform-wide — a key
minted under a shared identity would outlive the session that created it.

## Creating a key

1. Open **Settings → Integrations**.
2. In the **Personal API Key** card, choose **Generate API key**.
3. Optionally give the key a name and a lifetime, then confirm.

The API key and the client secret are shown once, in the panel that appears. They are stored hashed
(the secret) or not at all (the key), so neither can be shown again — generate a new key if you lose
one.

The same card lists the endpoints the key works against, so there is no base URL to guess:

- the base URL of the deployment
- the OpenAI-compatible API (`/api/inference/v1`)
- the MCP gateway (`/mcp` and `/mcp/sse`), when the gateway is enabled
- the OAuth token endpoint, when client credentials are offered

## Using a key

Send the API key as a bearer token:

```bash
curl https://ihub.example.com/api/inference/v1/chat/completions \
  -H "Authorization: Bearer <api key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'
```

The same key works against the MCP gateway, so an MCP client can be pointed at iHub with nothing
but the endpoint and the key:

```bash
curl https://ihub.example.com/mcp \
  -H "Authorization: Bearer <api key>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

If you prefer short-lived tokens, exchange the client credentials instead:

```bash
curl -X POST https://ihub.example.com/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "<client id>",
    "client_secret": "<client secret>"
  }'
```

The resulting access token also acts as the owner and expires after
`oauth.defaultTokenExpirationMinutes`.

## Rotating and revoking

**Rotate** issues a fresh API key and client secret and invalidates everything issued for that key
earlier - including any access token already exchanged from the previous client secret. It also
refreshes the owner snapshot, so a user who has since joined or left a group gets credentials that
reflect their current membership.

**Revoke** deletes the backing client. Every credential ever issued for it stops working on the next
request.

A key also stops working once its lifetime is up. The API key itself expires on its own, and the
client ID and secret stop being accepted at the token endpoint at the same moment, so
`maxExpirationDays` binds both credentials rather than only the one the user was shown.

## Administration

Personal keys appear in **Admin → OAuth → Clients** alongside service accounts, so an administrator
can review who holds keys and suspend or delete any of them. Creating, rotating and revoking a key
is written to the audit log as the `personalApiKey` resource.

## Security model

- **A key never exceeds its owner.** Permissions are resolved from the owner's groups on every
  request, exactly as for a browser session.
- **A key never reaches the admin API.** `/api/admin/*` is closed to personal keys — and to every
  other delegated or machine token — even when the owner is an administrator. Administration stays a
  browser-session activity.
- **A key cannot mint another key.** The endpoints that manage keys accept only an interactive
  session. A personal key, an OAuth service account, a static API key, a delegated
  authorization-code token and an agent principal are all refused - otherwise a narrow, short-lived
  delegation could be traded for a long-lived key carrying the owner's full permissions.
- **A key cannot outlive its policy.** The lifetime is capped by `maxExpirationDays` and enforced on
  both credentials; disabling the feature, or the client-credentials option, stops every existing
  key at once.
- **A rotated credential is refused, not merely replaced.** Each key carries a generation that every
  issue advances, and both credentials are bound to the generation they were issued for. In a
  clustered deployment a worker that has not yet seen the rotation may accept the superseded
  credential for a moment, exactly as it would still accept a key deleted a moment ago.
- **Group changes need a rotation.** The owner snapshot is written when the key is created and
  refreshed when it is rotated. If a user's group membership changes, rotate or revoke their keys so
  the change applies to credentials issued earlier.
- **Users only see their own keys.** A key belonging to somebody else is reported as missing rather
  than as forbidden, so the endpoints never confirm that it exists.
