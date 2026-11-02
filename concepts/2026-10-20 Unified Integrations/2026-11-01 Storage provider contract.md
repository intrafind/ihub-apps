# Storage provider contract (third-party storage providers)

**Date:** 2026-11-01 (written 2026-11-02)
**Status:** Design, not implemented — ready to file as an issue (text at the end)
**Decision:** [07 · Types and built-in configuration, section 5](07-types-and-built-in-configuration.md): "The `files` contract (browse, pick, download, per-user sign-in) is written down for third-party storage providers."
**Builds on:** [2026-11-02 Storage providers as installations](2026-11-02%20Storage%20providers%20as%20installations.md), [04 · Architecture §1.1 (`storage`), §4 (`GET /api/integrations/:id/files?path`)](04-architecture.md)

## Why it is not part of the storage PR

A third-party storage provider needs more than a connector function: a generic per-user OAuth
client for `script` definitions (today each shipped provider hard-codes its endpoints in a service
class), generic routes, a generic file browser in the chat (today there are three provider-specific
browsers), a generic project cloud kind, and the shipped providers adapted to all of it while their
old callback URLs keep working. Doing part of it would leave a contract nobody can implement end to
end. The storage PR therefore made the three providers several-per-type, bound per app and
granted per group — the parts every future provider builds on — and this document is the rest.

## Goal

A definition of `type: storage` with `protocol.type: "script"` (or `native`) brings files into
iHub like Office 365, Google Drive and Nextcloud do: users connect their own account, browse,
pick files for a chat or a project, and iHub downloads them. Whoever publishes such a definition
writes one connector module; iHub supplies everything else (sign-in flow, token storage and
refresh, grants, routes, UI, size limits, audit).

## What iHub owns

| Concern | Today (shipped providers) | For every storage provider |
| --- | --- | --- |
| Sign-in (authorization code, PKCE, signed `state`) | `oauthIntegrationFactory.js` per service | the same factory, mounted once for all storage installations |
| Redirect URI | `resolveCloudStorageRedirectUri` | the same, with a generic callback path |
| Token storage and refresh, 401 retry | `TokenStorageService`, `OAuthIntegrationBase` | the same; service name `storage`, key `<userId>__<installation id>` |
| Who may use it | `permissions.integrations` (`mayUseIntegration`) | unchanged |
| Which apps offer it | `shared/storageBindings.js` | unchanged (`type:storage`, definition id, installation id) |
| Size caps, content type, `Content-Disposition` | per route | in the generic download route |
| Connections list, disconnect, test | the cloud storage connectors | generic, from the contract |

## The definition

```jsonc
{
  "id": "com.example/box",
  "type": "storage",
  "capabilities": ["files"],
  "protocol": { "type": "script", "module": "connector.js" },
  "auth": {
    "modes": ["oauth-user"],
    "oauthUser": {
      // Declarative OAuth: iHub runs the flow. A connector may override any step (below).
      "authorizeUrl": "https://account.box.com/api/oauth2/authorize",
      "tokenUrl": "https://api.box.com/oauth2/token",
      "scopes": ["root_readonly"],
      "pkce": true,
      "clientIdField": "clientId",          // install fields holding the OAuth app
      "clientSecretField": "clientSecretRef" // a `credential` field
    }
  },
  "install": [ /* clientId, clientSecretRef, redirectUri, provider settings */ ],
  "actions": []
}
```

URLs may use `{values.<field>}` placeholders (a Nextcloud-like provider: `{values.serverUrl}/apps/oauth2/authorize`).
Every outbound call goes through `httpFetch` (proxy, SSL whitelist, SSRF guard).

## The connector module

```js
export default {
  id: 'box',
  actions: {},
  files: {
    /** Optional: the top-level entries the picker starts with (OneDrive, SharePoint, Teams). */
    async roots(ctx) {
      return [{ path: '/', name: 'All files', icon: 'folder' }];
    },
    /** One folder. `path` is opaque to iHub: whatever `list` returned before. */
    async list(ctx, { path, cursor, query }) {
      return {
        entries: [
          { ref: 'file:123', path: '/Reports/q1.pdf', name: 'q1.pdf', folder: false,
            size: 1024, mimeType: 'application/pdf', lastModified: '2026-10-01T12:00:00Z',
            url: 'https://app.box.com/file/123' }
        ],
        cursor: null // next page, or null
      };
    },
    /** One file's bytes. iHub caps the size and sets the response headers. */
    async download(ctx, { ref, signal }) {
      return { name: 'q1.pdf', mimeType: 'application/pdf', size: 1024,
               lastModified: '2026-10-01T12:00:00Z', content: Buffer.from('…') };
    },
    /** The signed-in account, for Settings → Integrations and the test. */
    async account(ctx) {
      return { displayName: 'Erin', email: 'erin@example.com' };
    },
    // Optional overrides of the declarative OAuth steps:
    // authorizeUrl(ctx, { redirectUri, state, codeChallenge }) → string
    // exchangeCode(ctx, { code, redirectUri, codeVerifier }) → { accessToken, refreshToken, expiresIn }
    // refresh(ctx, { refreshToken }) → same shape (a rotated refresh token is stored)
  },
  async test(ctx) { /* steps, like every connector */ }
};
```

`ctx` carries `definition`, `instance`, `values` (secrets resolved), `user`, and for `list`,
`download` and `account` an `api(url, init)` helper that sends the user's access token, refreshes
it once on 401 and goes through `httpFetch`. The connector never sees or stores tokens itself.

Errors: throw `StorageError` codes `NOT_CONNECTED` (→ 401, "connect first"), `NOT_FOUND` (→ 404),
`FORBIDDEN` (→ 403), `UNAVAILABLE` (→ 503, tokens kept) — the same distinction
`oauthRefreshError.js` makes today.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/integrations/:id/connect?returnUrl=` | start the sign-in (302 to the provider); `:id` is a storage installation the user's groups grant |
| `GET /api/integrations/storage/callback` | the one callback for every installation; the installation is in the signed `state` |
| `GET /api/integrations/:id/connection` · `DELETE /api/integrations/:id/connection` | status (account, token expiry) and disconnect; open whatever the grant, as today |
| `GET /api/integrations/:id/files?path=&cursor=&q=` | `files.roots` (no `path`) or `files.list` |
| `GET /api/integrations/:id/files/content?ref=` | `files.download`, as an attachment (`application/octet-stream`), size-capped |

`:id` is validated against the installations (no path building from input), the grant is checked
on every route but connection status and disconnect, and every download is audited.

**The shipped providers** move behind the same routes through a `files` implementation that wraps
their services (`Office365Service`: roots = the sources, `path` = `<source>/<driveId>/<itemId>`;
`GoogleDriveService`: ids; `NextcloudService`: WebDAV paths). Their old routes stay as aliases
for one release, and their callbacks
`/api/integrations/{office365,googledrive,nextcloud}/<id>/callback` stay **for good**: admins
registered them with Microsoft, Google and Nextcloud. Their token files stay under their services
(`office365/`, `googledrive/`, `nextcloud/`); only new providers use `storage/`.

## Client

- `GenericFileBrowser` on `useCloudStorageBrowser` over the generic routes: breadcrumb of
  `path`s, folders first, search when the connector supports `query`, paging by `cursor`, the
  existing "Connect" card when the route answers 401 `NOT_CONNECTED`.
- `CloudStoragePicker` picks the browser by definition: the three shipped ones keep theirs until
  they are moved, every other `type: storage` definition gets the generic one.
- `/api/auth/status` already lists every granted storage installation with `definition`; the
  provider `type` becomes the definition id for third-party ones.

## Projects

A generic item kind `storage-file` with `ref: { providerId, ref, name, mimeType, url }`,
downloading through `files.download` with the picking user's connection (as `cloudKinds.js` does);
the three shipped kinds stay.

## Ready-to-file issue

**Title:** Third-party storage providers: a `files` contract for `type: storage` definitions

**Body:**

> Part of #2911, follows #3094. Storage providers are installations now (several per provider,
> bound per app with `type:storage` / definition / installation, granted per group), but only the
> three shipped definitions can provide files: each has a hard-coded service, routes and browser.
>
> **Goal:** a `script` (or `native`) definition of `type: storage` provides files for the chat's
> picker and for projects by implementing one connector, as described in
> `concepts/2026-10-20 Unified Integrations/2026-11-01 Storage provider contract.md`.
>
> **Scope**
> - [ ] Definition schema: `auth.oauthUser` with `authorizeUrl`, `tokenUrl`, `scopes`, `pkce`,
>   `clientIdField`, `clientSecretField` (placeholders from install values); validated for
>   `type: storage`.
> - [ ] Connector contract `files: { roots?, list, download, account, authorizeUrl?, exchangeCode?, refresh? }`
>   with `ctx.api()` (token, refresh on 401, `httpFetch`); `StorageError` codes.
> - [ ] Generic OAuth flow on `oauthIntegrationFactory.js` (one callback
>   `/api/integrations/storage/callback`, installation in the signed state), token service
>   `storage`, key `<userId>__<installation id>`.
> - [ ] Routes `GET /api/integrations/:id/connect`, `GET|DELETE /api/integrations/:id/connection`,
>   `GET /api/integrations/:id/files`, `GET /api/integrations/:id/files/content`; grant checks,
>   size cap, audit.
> - [ ] Client `GenericFileBrowser`; `CloudStoragePicker` uses it for every storage definition
>   other than the three shipped; Settings → Integrations lists third-party providers.
> - [ ] Project item kind `storage-file`.
> - [ ] Connectors for the three shipped providers implementing `files` over their services; old
>   browse routes kept as aliases for one release; the three callback URLs kept for good.
> - [ ] Docs: `docs/integrations.md` (contract, example connector), changelog.
>
> **Acceptance**
> - A sample `script` definition (e.g. a WebDAV provider with server URL, client id and secret)
>   installed from a trusted registry can be connected by a user, browsed and picked in a chat
>   that binds it, and imported into a project.
> - Office 365, Google Drive and Nextcloud work through the generic routes; existing connections
>   and registered redirect URIs keep working without admin action.
> - Tests: contract unit tests with a fake connector (list, download, refresh on 401, rotated
>   refresh token, `NOT_CONNECTED`), route tests (grant, unknown id, size cap), client tests for
>   the generic browser, a migration-free upgrade (no config changes needed).
>
> **Out of scope:** writing to storage (save to cloud), search across providers, admin-owned
> (service account) connections.
