---
description: "Connect iFinder and iAssistant: setup, app binding, the search tools, the chat UI, troubleshooting and a query cheat sheet."
audience: admin
type: how-to
adminPage: /admin/integrations
---

# iFinder and iAssistant Integration

iFinder is IntraFind's enterprise search. iHub connects to it so that models can search the
documents your organisation indexed, read their text and metadata, and answer with links to them.
iAssistant is the retrieval-augmented answering service that runs on the same iFinder server. Every
call runs as the signed-in iHub user, so results follow iFinder's own permissions.

## Overview

iHub ships two built-in integrations under **Admin → Integrations**:

| Integration | Installation id | What it gives you |
| --- | --- | --- |
| **iFinder** | `ifinder` | Seven search and discovery tools, the per-chat search profile picker, the **Sources** panel for iFinder documents, the shipped **iFinder Search** app |
| **iAssistant** | `iassistant` | The `iassistant-conversation` model (multi-turn answers grounded in iFinder documents) and the **Ask the iAssistant** action for apps on any other model |

iAssistant has no base URL of its own: it uses the connection and the token of the `ifinder`
installation. Install iFinder first.

```mermaid
graph TB
    A[iHub user] --> C[iHub server]
    C --> E[iFinder tools]
    C --> F[iAssistant model and ask action]
    E --> H[iFinder public API]
    F --> I[iAssistant conversation API]
    H --> J[iFinder index]
    I --> J
    L[Per-user JWT] --> H
    L --> I
```

What users can do:

- Search documents in natural language; the model builds Lucene queries, filters, facets and
  sorting.
- Read a document's text or metadata, and summarise, compare or analyse it.
- Follow up on documents listed earlier in the chat.
- Jump from a cited passage to its position in the source document, highlighted in the PDF preview.
- Pick the search profile (or iAssistant) per chat.

Anonymous users can never use iFinder or iAssistant: every call needs a signed-in user.

## Prerequisites

- An iFinder instance with the public API reachable from the iHub server over HTTPS. If it uses a
  private CA, add its host to `ssl.domainWhitelist` in `platform.json`.
- For iAssistant: the iAssistant service enabled on that iFinder.
- iHub user authentication configured (local, OIDC, LDAP, proxy, …). iFinder must recognise the
  identity iHub sends as the token subject (usually the e-mail address).
- A trust relationship between iHub and iFinder, so iFinder accepts the per-user tokens iHub sends.
  See [Authentication](#authentication).
- Search profiles set up in iFinder with the right user permissions. Ask your iFinder administrator;
  typical profiles are `searchprofile-standard`, or dedicated ones for policies, HR or technical
  documents.

## Configuration

iFinder is a [built-in installed integration](integrations.md#built-in-integrations). Its settings
are the `ifinder` installation in `contents/config/integrations.json`, not `platform.json`. The file
reloads automatically. The installation's own switch (`enabled`) turns the integration on and off.

### Install iFinder

1. Set up authentication first. For the recommended keyless setup, set the OAuth issuer URL under
   **Admin → Authentication → OAuth Server** and restart, then configure iFinder to trust iHub. See
   [iFinder Authentication](ifinder-oidc-jwt.md).
2. Open **Admin → Integrations**, pick **iFinder** in the catalog and click **Install** (later
   **Edit**).
3. Enter the **iFinder base URL**, for example `https://ifinder.example.com`.
4. Choose the **Authentication** and its settings:
   - *JWT signed by iHub* with **Sign with iHub's OIDC key pair** ticked (recommended), or
   - *JWT signed by iHub* with a **Private key** credential (legacy), or
   - *OIDC token exchange* when iHub and iFinder share an OIDC provider.
5. Set **User identity sent to iFinder** to the attribute iFinder knows users by (usually
   `email`).
6. Set the **Default search profile** and, optionally, the **Offered search profiles**.
7. Click **Test**. It runs the full [connection diagnostics](#testing-the-connection) on the values
   in the wizard, before anything is saved.
8. Click **Install** / **Save**.
9. Grant the installation to the groups that may use iFinder (`permissions.integrations` in
   `groups.json`), and bind it to apps (see [Binding to apps](#binding-to-apps)).

The private key is never stored in a config file. For the legacy key setup, create a credential
under **Admin → Credentials** (type **Secret**, the PEM key as its value) and pick it in the
**Private key** field; the installation stores a `privateKeyRef` that points at it.

### iFinder installation fields

Advanced fields are folded away in the wizard.

| Field | Key | Default | Description |
| --- | --- | --- | --- |
| iFinder base URL | `baseUrl` | - | The iFinder server; the public API paths are appended. `IFINDER_API_URL` wins over it when set |
| Authentication | `authMode` | `ihubSigned` | `ihubSigned` (iHub signs the token) or `oidcTokenExchange` (a shared OIDC provider issues it, see [Shared OIDC Provider](ifinder-oidc-jwt.md#shared-oidc-provider-token-exchange)) |
| Sign with iHub's OIDC key pair | `useOidcKeyPair` | `false` | Keyless signing with the iHub OIDC key, verified by iFinder through JWKS (recommended) |
| Private key | `privateKeyRef` | - | Credential holding the PEM private key; ignored with `useOidcKeyPair` or token exchange. `IFINDER_PRIVATE_KEY` wins over it |
| User identity sent to iFinder | `jwtSubjectField` | `email` | Which user attribute becomes the token's `sub`: `email`, `username`, `id`, `name` or `domain\username`, or a template with `${user.field}` placeholders such as `CONTOSO\${user.username}` (see [`jwtSubjectField` supported values](platform.md#jwtsubjectfield-supported-values)) |
| Signing algorithm, JWT issuer, JWT audience, Token lifetime (seconds), Token scope | `algorithm`, `issuer`, `audience`, `tokenExpirationSeconds`, `defaultScope` | `RS256`, `ihub-apps`, `ifinder-api`, `3600`, `fa_index_read` | Advanced token settings for `ihubSigned`. The lifetime accepts 60 to 86400 seconds |
| OIDC provider for token exchange, grant, audience, scopes | `tokenExchangeProvider`, `tokenExchangeGrant`, `tokenExchangeAudience`, `tokenExchangeScopeIndexRead`, `tokenExchangeScopeAssistant`, `tokenExchangeScopeSmartCollections`, `tokenExchangeExtraScopes` | - | The `oidcTokenExchange` settings, see [Configure iHub](ifinder-oidc-jwt.md#configure-ihub) |
| Default search profile | `defaultSearchProfile` | `searchprofile-standard` | Searched when neither the chat nor the model names a profile. `IFINDER_SEARCH_PROFILE` applies only while this is empty |
| Offered search profiles | `allowedSearchProfiles` | `[]` (all of the user's) | Which of the user's profiles the chat picker offers and the tools may search. The default profile is always allowed |
| Users may change the search profile | `allowUserSearchProfileChange` | `true` | `false` pins every chat to the default profile |
| Search profile application | `searchProfileApplication` | `ifinder` | The iFinder application whose profile assignments are read for a user (advanced) |
| Request timeout (ms) | `timeout` | `30000` | Bounds every iFinder tool call (advanced) |
| Download directory | `downloadDir` | `contents/data/ifinder-downloads` | Where fetched files are stored (advanced) |
| Search, Document, Fields, Facets endpoint path | `searchEndpoint`, `documentEndpoint`, `fieldsEndpoint`, `facetsEndpoint` | the iFinder public API paths | Advanced; change only for a non-standard deployment |

The installation in `contents/config/integrations.json`:

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
        "jwtSubjectField": "email",
        "defaultSearchProfile": "searchprofile-standard",
        "allowedSearchProfiles": [],
        "allowUserSearchProfileChange": true
      }
    }
  ]
}
```

For the legacy key setup, use `"useOidcKeyPair": false` and `"privateKeyRef": "<credential id>"`.
To keep a development key apart from production, give it its own credential (for example
`ifinder_dev`); there is no per-environment variable name.

There is no rate-limit or retry setting on the installation: use the platform's `rateLimit`
settings or a gateway in front of iFinder. Request logging is the platform's `logging.level`.

Installations that configured iFinder in `platform.json` are moved here by migration V192 on the
first start, which also removes `contents/tools/iFinder.json` and rewrites the apps to bind the
installation.

### Environment variables

| Variable | Effect |
| --- | --- |
| `IFINDER_API_URL` | Wins over the installation's base URL |
| `IFINDER_PRIVATE_KEY` | PEM private key; wins over the **Private key** credential. Ignored with `useOidcKeyPair`. Real newlines or `\n` escapes both work |
| `IFINDER_SEARCH_PROFILE` | Used only while the installation's **Default search profile** is empty |
| `IASSISTANT_PROFILE_ID` | Used only while the iAssistant installation's **Default conversation profile** is empty |

```bash
IFINDER_API_URL=https://ifinder.example.com
IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKrCFR...
-----END PRIVATE KEY-----"
```

There is no `IFINDER_PRIVATE_KEY_FILE` and no environment variable for the timeout or download
directory. Precedence, highest first: environment variables (`IFINDER_SEARCH_PROFILE` only as a
fallback), the installation's values, the built-in defaults. Restart the server after changing an
environment variable.

## Authentication

iFinder trusts a call only when it carries a JWT for the user. There are three ways to establish
that trust; [iFinder Authentication](ifinder-oidc-jwt.md) describes each one step by step, including
the iFinder-side settings.

| Mode | Settings | Key management |
| --- | --- | --- |
| **Keyless (recommended)** | `authMode: "ihubSigned"`, `useOidcKeyPair: true`, `oauth.issuer` in `platform.json` | None: iFinder fetches iHub's public key from `/.well-known/jwks.json` |
| **Shared OIDC provider** | `authMode: "oidcTokenExchange"` and the `tokenExchange*` fields | None: the provider issues the token; only users who signed in through that provider can use iFinder |
| **Manual key pair (legacy)** | `authMode: "ihubSigned"`, `privateKeyRef` or `IFINDER_PRIVATE_KEY` | Generate an RSA key pair, upload the public key into iFinder, rotate by hand |

In the `ihubSigned` modes iHub signs one token per user and call with these claims:

```json
{
  "sub": "user.email@example.com",
  "name": "User Name",
  "iat": 1643723400,
  "exp": 1643727000,
  "iss": "https://ihub.example.com",
  "aud": "ifinder-api",
  "scope": "fa_index_read"
}
```

- `sub` comes from **User identity sent to iFinder**. If the user lacks that attribute, the call
  fails with an error naming the field; iHub never falls back to another attribute.
- `iss` is the OAuth issuer URL in keyless mode, otherwise the **JWT issuer** (`ihub-apps`).
- `scope` is `fa_index_read` for search. iAssistant calls request `fa_iassistant`, and the calls
  that list a user's smart collections (projects of the iFinder tier, see
  [Projects](projects.md#the-ifinder-tier-smart-collections)) request `fi_smartcollections`; the
  user needs those roles in iFinder.

The same token serves the iFinder tools and iAssistant.

## Setting up iAssistant

1. Install and test iFinder first.
2. Open **Admin → Integrations**, pick **iAssistant** and click **Install**.
3. Leave **iFinder installation** at `ifinder`.
4. Set the **Default conversation profile** (the iAssistant profile id used when an app names none)
   and the **Default search profile**.
5. Click **Test**: besides the connection, it lists the conversation profiles iAssistant offers and
   checks that the default profile is among them.
6. Make sure the `iassistant-conversation` model exists in `contents/models/` and is enabled (it
   ships in `server/defaults/models/`).

| Field | Key | Default | Description |
| --- | --- | --- | --- |
| iFinder installation | `connection` | `ifinder` | The iFinder installation whose base URL and token iAssistant uses (required) |
| Default conversation profile | `defaultProfileId` | - | Used when an app sets no `iassistant.profileId`. `IASSISTANT_PROFILE_ID` applies while empty |
| Default search profile | `defaultSearchProfile` | `searchprofile-standard` | Searched when neither the app nor the model names a profile |
| Check the user's access to the search profile | `verifySearchProfileAccess` | `true` | Before a conversation starts, check the user has the profile; fall back to the user's default when not |
| Answer only from retrieved documents | `groundedOnly` | `false` | Installation-wide default; an app's `iassistant.groundedOnly` wins |
| Search profile cache (ms) | `searchProfileCacheTtlMs` | `300000` | How long a user's profile list is cached (advanced) |

```json
{
  "id": "iassistant",
  "definition": "com.intrafind/iassistant",
  "enabled": true,
  "values": {
    "connection": "ifinder",
    "defaultProfileId": "iassistant-workspace",
    "defaultSearchProfile": "searchprofile-standard",
    "verifySearchProfileAccess": true,
    "groundedOnly": false
  }
}
```

There are two ways to use iAssistant:

- **As the chat model.** An app on the `iassistant-conversation` model that binds the installation
  (`"integrations": { "iassistant": { "actions": [] } }`) talks to iAssistant in multi-turn
  conversations. Per-app settings are in [Apps → iAssistant Configuration](apps.md#iassistant-configuration).
- **As a tool for other models.** The action **Ask the iAssistant** (`ask`, tool
  `iassistant__ask`) sends one question and returns one grounded answer, with the cited documents
  as the answer's sources. It is opt-in per app: tick it under **Admin → Apps → Edit → Installed
  integrations → iAssistant**, or `"integrations": { "iassistant": { "actions": ["ask"] } }`. The
  iAssistant the user picked in the chat (or the app pinned) is the one asked. See
  [Integrations → Built-in integrations](integrations.md#built-in-integrations).

iAssistant has no request timeout of its own: a turn is bounded by the model's `connectTimeoutMs`
and `streamIdleTimeoutMs` (see [Platform → Request timeouts](platform.md#request-timeouts)).

## Binding to apps

### Binding the tools to an app

The iFinder tools are the actions of the `ifinder` installation, so an app does not list them as
tools. It binds the installation under `integrations` and names the actions it wants (the tool ids
without the `iFinder_` prefix), or none for all of them:

```json
"integrations": {
  "ifinder": { "actions": ["search", "getContent", "getMetadata"] }
}
```

- `"actions": []` binds the installation without tools, which still gives the chat the search
  profile picker.
- The binding is also a requirement: the app is offered to users only while the installation exists
  and is enabled, and **Admin → Apps** names a missing one.
- **Admin → Apps → Edit → Installed integrations** writes the object.
- Which groups may use iFinder is the grant of the `ifinder` installation
  (`permissions.integrations` in `groups.json`).
- `pinnedScope` fixes the app to one search profile.

See [Apps → Integrations](apps.md#integrations-binding-an-installed-integration) and
[Apps → Integration scopes](apps.md#integration-scopes-where-to-search-and-whom-to-ask).

### Example apps

An enterprise knowledge chat (`contents/apps/enterprise-knowledge-chat.json`):

```json
{
  "id": "enterprise-knowledge-chat",
  "order": 1,
  "name": { "en": "Enterprise Knowledge Chat", "de": "Unternehmenswissen Chat" },
  "description": {
    "en": "Chat with enterprise knowledge using iFinder document search",
    "de": "Chat mit Unternehmenswissen über iFinder-Dokumentensuche"
  },
  "color": "#2563eb",
  "icon": "building-columns",
  "system": {
    "en": "You are an enterprise knowledge assistant with access to company documents through iFinder. Answer from the retrieved information and always cite sources."
  },
  "preferredModel": "gpt-4o",
  "integrations": {
    "ifinder": { "actions": ["search", "getContent"] }
  },
  "category": "Enterprise",
  "enabled": true
}
```

Add `"websearch": { "enabled": true }` to research both the web and iFinder; tell the model in the
system prompt to distinguish internal from external sources.

An HR app pinned to one profile, with the installation offering several:

```json
{
  "id": "ifinder",
  "definition": "com.intrafind/ifinder",
  "enabled": true,
  "values": {
    "baseUrl": "https://ifinder.example.com",
    "useOidcKeyPair": true,
    "defaultSearchProfile": "searchprofile-standard",
    "allowedSearchProfiles": [
      "searchprofile-standard",
      "searchprofile-hr-docs",
      "searchprofile-tech-docs",
      "searchprofile-policies"
    ],
    "allowUserSearchProfileChange": true
  }
}
```

```json
{
  "id": "hr-assistant",
  "name": { "en": "HR Assistant" },
  "preferredModel": "gpt-4o",
  "integrations": {
    "ifinder": {
      "actions": ["search", "getContent"],
      "pinnedScope": "searchprofile-hr-docs"
    }
  }
}
```

## Testing the connection

Click **Test** on the iFinder or iAssistant installation under **Admin → Integrations** (the install
wizard has the same button for unsaved values). Instead of a single pass/fail, it walks the whole
connection path and reports what it saw at each step:

| Step | What it proves |
| --- | --- |
| Configuration | Which key signs the JWT, which subject field is used, which endpoints and profile are configured |
| Base URL | Scheme, hostname, port, and whether the hostname is fully qualified |
| DNS resolution | Whether the iHub server resolves the hostname, and to which addresses |
| TCP / TLS connection | Whether the port answers; certificate subject, issuer, expiry and trust result |
| JWT generation (or Token exchange) | The decoded header and payload, and the subject derived for you |
| JWT signature | That iHub verifies its own token with the matching public key |
| Issuer reachable | The issuer and JWKS URL **iFinder itself has to call back to** (keyless mode) |
| JWKS endpoint | That the endpoint publishes keys and the token's `kid` is among them |
| API request | The exact URL and method, response status, headers and a body excerpt |

Each failing step lists what to check; expand a step for the raw observations as JSON. The test runs
as your own account: the JWT is minted for the signed-in admin and is never returned. To see the
subject for another kind of user, sign in as such a user and run the test.

The same checks are available over the API, for example for monitoring (there is no built-in
scheduled health check):

```bash
curl -X POST https://ihub.example.com/api/admin/integrations/installed/ifinder/_test \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://ihub.example.com/api/admin/integrations/installed/iassistant/_test \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Without a body the saved installation is tested; a body shaped like an installation (`values`,
`enabled`, …) tests those values instead. The search term and profile are not parameters: the test
uses the configured default profile with a fixed query, so no request value can change which URL iHub
contacts. The response's `result` has `success`, a `summary` of step counts, and the ordered `steps`
with `status` (`ok` / `warn` / `fail` / `skip`), `message`, `details` and `hints`.

The test cannot check reachability **from the iFinder host**. For keyless mode, run this there:

```bash
curl -sv https://ihub.example.com/.well-known/jwks.json
```

After the test passes, check the whole flow by hand:

1. As an anonymous user, iFinder apps are not available.
2. As a signed-in user, the **iFinder Search** app finds documents, reads one and shows its
   metadata.
3. Users with different iFinder permissions see different results.
4. An app on the `iassistant-conversation` model answers with sources and keeps context across
   turns.

## Available Tools

The iFinder installation exposes these functions under the `iFinder.` namespace (tool ids
`iFinder_<function>`, also over the MCP gateway):

| Function | Purpose | Required parameter | Example |
| --- | --- | --- | --- |
| `search` | Find documents with a Lucene query, filters, facets, sorting and paging | `query` | `{query: "contracts 2024"}` |
| `getContent` | Fetch a document's extracted text | `documentId` | `{documentId: "doc123"}` |
| `getMetadata` | Fetch a document's metadata without its text | `documentId` | `{documentId: "doc123"}` |
| `getFields` | The index field catalog: which fields exist and which need `.keyword` | - | `{filterPrefix: "cust."}` |
| `getFacetValues` | Enumerate the values of one facet | `facet` | `{facet: "application.keyword"}` |
| `listProfiles` | The search profiles this user can reach | - | `{}` |
| `discover` | One probe returning totals, top facets, sample titles and the field catalog | `searchProfile` | `{searchProfile: "searchprofile-standard"}` |

The last four are the discovery surface; see [Discovering what is searchable](#discovering-what-is-searchable).

### iFinder.search

Parameters:

- `query` (required): Lucene query string with `AND`/`OR`/`NOT`, quoted phrases, `field:value`,
  wildcards and ranges, plus the [IntraFind operators](#intrafind-operators). `*` matches everything.
- `maxResults`: maximum hits (default 10, max 100).
- `from`: offset of the first hit, for paging past the 100-hit cap.
- `filter`: array of Lucene query strings ANDed with the query but excluded from relevance ranking;
  the right place for narrowing criteria.
- `searchProfile`: search profile id.
- `returnFields`: fields to return (`*` for all).
- `returnFacets`: facet fields to aggregate alongside the hits.
- `sort`: array of `field:asc` / `field:desc`.

```javascript
iFinder.search({
  query: 'technical documentation',
  maxResults: 20,
  filter: ['application.keyword:PDF', 'modificationDate:[2026-01-01 TO *]'],
  returnFields: ['id', 'title', 'creators', 'modificationDate'],
  returnFacets: ['sourceName.keyword', 'language.keyword'],
  sort: ['modificationDate:desc']
});
```

```json
{
  "query": "contract proposals",
  "searchProfile": "default",
  "totalFound": 15,
  "took": "125ms",
  "results": [
    {
      "id": "doc123456",
      "title": "Q4 Contract Proposals",
      "creators": "SMITH, John",
      "creationDate": "2024-01-15T09:00:00Z",
      "modificationDate": "2024-01-16T14:25:00Z",
      "application": "PDF",
      "sourceName": "SharePoint",
      "deepLink": "https://…/Q4%20Contract%20Proposals.pdf",
      "score": 0.95
    }
  ],
  "facets": {}
}
```

Each hit carries its `id` (the `documentId` that `getContent` and `getMetadata` take), `creators`,
`owners`, `creationDate` and `modificationDate` (the field "newest first" sorts on), so a result list
can be judged without a metadata call per hit. Keys a source has no value for are omitted.

**Field names and `.keyword`.** Every text field is indexed twice: the plain name (`creators`) is
analysed for relevance-ranked matching, and the `.keyword` name (`creators.keyword`) holds the exact
value for filtering, faceting and sorting. Dates, numbers and booleans take no suffix. Some text
fields (`title`, `content`, `url`, `subject`) have no `.keyword` variant at all, and a filter on one
matches nothing rather than failing. `iFinder.getFields` reports the right name per purpose.

### The IntraFind query syntax

iFinder does not run a plain Lucene parser. The search service hands OpenSearch the query as
`intrafind_query_string`, a query type of the IntraFind Insight plugin, which takes all of Lucene's
syntax plus the [IntraFind operators](#intrafind-operators), in `query` and in `filter`. Boolean
operators also accept German aliases (`UND`, `ODER`, `NICHT`), and a field prefix goes in front of
any operator: `content:NEAR/S(ENTITY/PERS AND Kündigungsfrist)`.

Do not confuse this with the request body's `"query_type": "QueryStringQuery"`: that is the API's
discriminator for the shape of the query object; the engine query type is chosen server-side.

The search service enables the IntraFind parser by default
(`searchservice.use-intrafind-queryparser`), and a search profile can override the engine query
type, so the operators are normally on but can be off. A parser that does not know an operator
treats it as a literal term and quietly matches nothing: compare `totalFound` with and without the
operator. The `ifinder-search` skill documents the full grammar with worked examples in
`references/intrafind-query-syntax.md`.

### iFinder.getContent

Parameters:

- `documentId` (required): the `id` of a search hit. A value that cannot be an id (one with
  whitespace, or a URL) is rejected before any request; a 404 carries the same hint: search for the
  document and pass the `id` of the matching hit.
- `maxLength`: maximum characters returned (default 50000). Longer text is cut and `truncated` is
  `true`.
- `searchProfile`: search profile id.

```json
{
  "documentId": "doc123456",
  "content": "Full document text content...",
  "contentLength": 8542,
  "contentLengthFormatted": "8.5K characters",
  "metadata": {
    "title": "Q4 Contract Proposals",
    "author": "John Smith",
    "documentType": "pdf",
    "mimeType": "application/pdf"
  },
  "truncated": false
}
```

### iFinder.getMetadata

Parameters:

- `documentId` (required): the `id` of a search hit. A title, file name or link is rejected with a
  hint on how to get the id (search, for example `title:"…"`, and take the hit's `id`); the same hint
  comes back when no document has that id. A hit whose `id` differs from the one asked for is
  reported as not found rather than returned as the wrong document.
- `searchProfile`: search profile id.
- `returnFields`: fields to return. Defaults to `id`, `title`, `creators`, `owners`, `language`,
  `accessInfo.*`, `mediaType`, `sourceType`, `file.*`, `sourceLocations.*`, `navigationTree`,
  `creationDate`, `modificationDate`, `indexingDate`, `application`, `contentLength`, `sourceName`
  and `url`.

The result is the document's hit fields plus `documentId`, `searchProfile`, `took` and
`totalFound`.

## Discovering what is searchable

A caller that guesses field names gets silent empty results, because a filter on a field without a
`.keyword` variant matches nothing. These four functions let an app, an agent or an MCP client read
the answer off the deployment instead.

### iFinder.getFields

Returns the index field catalog from the live OpenSearch mapping
(`GET /public-api/retrieval/api/v1/schema-types/{schemaType}/fields`).

- `schemaType`: schema type to describe, default `document`.
- `filterPrefix`: only fields starting with this prefix, for example `file.` or `cust.`.

```json
{
  "schemaType": "document",
  "totalFields": 157,
  "fields": {
    "creators": {
      "type": "text",
      "fullTextSearch": "creators",
      "filter": "creators.keyword",
      "aggregation": "creators.keyword",
      "sort": "creators.keyword"
    },
    "content": {
      "type": "text",
      "fullTextSearch": "content",
      "filter": null,
      "aggregation": null,
      "sort": null
    }
  },
  "fullTextSearchable": ["..."],
  "filterable": ["..."],
  "aggregatable": ["..."],
  "sortable": ["..."]
}
```

A `null` means the field does not serve that purpose. This is also the only way to learn a
deployment's custom `cust.*` fields.

### iFinder.getFacetValues

Enumerates the values of one facet (sources, authors, applications, languages) with a document
count each; far more values than the capped facet block of a search response.

- `facet` (required): an aggregatable field; text fields need `.keyword` (`creators.keyword`).
- `query`: scope query, default `*`.
- `filter`: additional Lucene filters.
- `maxValues`: default 50, max 1000.
- `sort`: `count:desc` (default), `value:asc`, `value:desc`.
- `searchProfile`.

```javascript
iFinder.getFacetValues({ facet: 'application.keyword', maxValues: 100 });
// → { facet, values: [{ value: 'PDF', count: 4210 }, ...], hasMore: false }
```

Use it before filtering on a value: casing and spelling are deployment data, so
`application.keyword:pdf` and `application.keyword:PDF` are different queries.

### iFinder.listProfiles

Lists the search profiles the calling user may search:

```javascript
iFinder.listProfiles();
// → { defaultSearchProfile: 'searchprofile-standard', source: 'ifinder',
//     profiles: [{ id: 'searchprofile-standard', name: 'Standard', isDefault: true, isUserDefault: true },
//                { id: 'searchprofile-legal', name: 'Legal', isDefault: false, isUserDefault: false }] }
```

The iFinder public API has no "list my search profiles" endpoint, so the list is read as the user
from iFinder's internal search API (`GET /internal-api/v2/search?action=getconfiguration`), where the
iFinder searchbar gets its profiles. iFinder assigns profiles per application; the list is read for
the installation's `searchProfileApplication`. It is cached per user for five minutes.

- `isDefault` marks the installation's `defaultSearchProfile`. It is always listed;
  `available: false` means the user does not have it.
- `isUserDefault` marks the user's own default profile in iFinder.
- When iFinder cannot be asked (`source: 'configured-default'`), only the configured default is
  reported. iFinder 6.9 answers 403 to a user without the feature `fi_ifinder_allow`.
- `allowedSearchProfiles` narrows the list; the default stays.
- In a chat whose profile is fixed, the tool is not offered; called anyway, it returns that one
  profile with `fixed: true`.

### iFinder.discover

One probe over a search profile: document count, top values of the main facets, sample titles, the
field catalog and a ready-to-paste markdown summary.

- `searchProfile` (required).
- `query`: scope query, default `*:*`.
- `facets`: facet fields to probe.
- `sampleSize`: sample documents, default 10.
- `includeFields`: also fetch the field catalog, default `true`.

Run it once against an unfamiliar profile. Its `markdown` field is what
[Admin-driven corpus discovery](#admin-driven-corpus-discovery) writes into an agent profile's memory.

### Using it from an MCP client

Over the MCP gateway the tools are `iFinder_search`, `iFinder_getFields`, and so on; the calling
group must be granted the `ifinder` installation (`permissions.integrations` in `groups.json`).

The `ifinder-search` skill in `contents/skills/` teaches a client the whole surface: query syntax,
the `.keyword` rule, filters versus query terms, facets, paging and the discovery loop, with a field
reference and a query cookbook. Grant it to a group and it is offered over the gateway as an MCP
resource (`ihub://skill/ifinder-search`).

> [!WARNING]
> The skill is a managed default: on every start the server refreshes `contents/skills/ifinder-search/`
> from the shipped files, so local edits are overwritten. To customise it, copy it under another
> skill id.

## User interface

### iFinder Search app

The shipped app `ifinder-search` ("iFinder Search") is the iFinder counterpart of the Web Chat app:
it researches the iFinder index as the signed-in user. It ships enabled and binds the `ifinder`
installation with all seven actions (`"integrations": { "ifinder": { "scopePicker": "menu" } }`), so
users see it only while the installation exists and is enabled. With the `skills` feature on, it
loads the `ifinder-search` skill on demand; otherwise the system prompt carries the essentials.

It handles two kinds of requests:

- **Questions** ("What is the notice period in our supplier contracts?"): the model searches several
  times with different wording and operators, judges hits by title, metadata and teasers, reads only
  the documents it needs, and answers with each statement linked to its document.
- **Document searches** ("show my latest tickets", "presentations about project X from last
  month"): the model builds filters (person, date range, type, source, status) and a sort, and lists
  the matching documents with link, date and relevant fields, without reading them unless asked.

Requests about the user ("my tickets", "documents I wrote") use the user's name and e-mail, which the
system prompt receives through `{{user_name}}` and `{{user_email}}`. iFinder stores names as
`"LASTNAME, Firstname"`, so the model first searches loosely on the last name with a facet on the
matching `.keyword` field (`task.assignee.keyword`, `creators.keyword`, …) and then filters on the
exact value it found.

The research behaviour lives in the system prompt, so you can adapt it, for example to name your
ticket system or your custom `cust.*` fields.

**Links and follow-up questions.** Only the message text of earlier turns is replayed to the model,
not the tool results, so the prompt has the model write every document link as
`[title](deepLink "source › location · id")`. The link title shows as a tooltip (which system and
folder the link opens), and the document id at its end lets a follow-up ("who wrote the second
one?") call `iFinder_getMetadata` or `iFinder_getContent`. A document known only by title is
searched again (`title:"…"`) and matched by its deep link first.

### Choosing the search profile per chat

In every app with iFinder tools, the **+** menu has an iFinder row under **Use in this chat** that
shows the current profile and opens a submenu; a chip under the composer then shows where the next
question goes. The iAssistant is picked the same way. The list is the user's own search profiles
(the same list `iFinder_listProfiles` reads), narrowed to **Offered search profiles** when set.

- The choice is saved with the chat and restored when it is reopened.
- It binds the model: `search`, `getContent`, `getMetadata`, `getFacetValues` and `discover` search
  the picked profile even when the model passes another one, and `listProfiles` is not offered.
- Without a pick, a profile the model names is checked the same way: one the user does not have, or
  one outside the allow-list, is refused with a list of the available profiles.
- The server checks the pick on every turn: a profile the user does not have, or one not on the
  allow-list, refuses the turn (`403 INTEGRATION_SCOPE_NOT_ALLOWED`).
- When iFinder cannot be asked for the list (403 for a user without `fi_ifinder_allow`, or iFinder is
  down), the picker offers the configured default and the allow-list with a short hint.
- With **Users may change the search profile** off, or an app's `integrations.ifinder.pinnedScope`,
  the profile is fixed and the picker only shows it.

Runs outside a chat keep a profile too. A [scheduled task](scheduled-tasks.md#where-a-task-searches)
stores the profile (and iAssistant) of the chat it was scheduled from, or the one picked on its form.
A [workflow step](workflows.md#integration-scopes-in-a-node) sets one with `integrationScopes`. Both
are checked as the user running them: a profile they no longer have fails the run with an error
naming it.

### Sources panel

The documents a turn's `iFinder_search`, `iFinder_getMetadata` and `iFinder_getContent` calls found
are listed in the chat's tool activity and in the **Sources** panel under the answer, like the
documents of an iAssistant answer and the pages of a web search (see
[Answer Sources](answer-sources.md)).

- Each document has **Preview (PDF)**, **Download**, **Details**, **Open in App**, **Copy link**,
  and **Add to email** in the Outlook task pane; its title opens the deep link. They are resolved
  with the user's own permissions (`GET /api/sources/ifinder/content|metadata`).
- Documents the answer links to are listed under **Cited in this answer**, numbered like their
  badges in the text; the other hits under **Also considered**. One call lists at most 50 documents.
- Every card names the search profile by its display name, and the header says where the answer
  searched (**Searched in Contracts**) or which iAssistant it asked (**Asked HR assistant**). See
  [Answer Sources → Integration scopes](answer-sources.md#integration-scopes).
- With [chat history](chat-persistence.md) on, the documents are stored with the answer; a
  [shared link](chat-sharing.md) never includes them.

### Passage highlighting in the document preview

Expanding a cited document shows the passages the search returned; each has a magnifier button that
opens the document at that passage. **Preview (PDF)** opens the same viewer with all of the
document's cited passages highlighted. The viewer steps from highlight to highlight (buttons, or
`Enter` / `Shift+Enter`), zooms, downloads, and can filter to one passage.

Both entries appear only for documents with an `ACCESS` link, which
`GET /api/integrations/ifinder/files/:id/content` needs to fetch the PDF rendition iFinder generates.

The preview's text layer differs from the indexed fulltext, so passages are matched on letters and
digits only (Unicode-normalised, case-insensitive):

- Punctuation, spacing, casing and ligatures never prevent a match; any script works.
- Passages across a page break are highlighted on both pages.
- A passage interrupted by a header or footer is split into fragments and highlighted partially.
- Trailing punctuation is not highlighted.
- A passage that is not in the generated PDF opens the preview with "Passage not found".

### Open in iHub

A link such as `/apps?documentId=<id>&integration=ifinder` (the iFinder hit action) opens the app
list with the document waiting. The apps offered are those that bind the iFinder integration; the
one the user picks receives the **original file** (never iFinder's preview), fetched by the server
with the user's own permissions and attached by reference, whatever the app's upload settings.
Images and audio are fetched in the browser. The installation must be configured and granted to the
user's groups, otherwise the list says so. See
[Auto-Send and URL Parameters](auto-send-feature.md#document-attachment-from-an-integration) and
[Chat and Scheduled-Task Files](chat-files.md#in-the-ui).

## Corpus workflows

### Lazy corpus workflows

The `stellungnahmen-review` workflow expects each statement to be uploaded into the chat, which
breaks the upload limit for consultations with 200+ documents. `stellungnahmen-review-ifinder` runs
the same extract-and-report flow with the same evidence schema, but takes candidates from iFinder:

1. `corpus-search` runs with `fetchFulltext: false` and returns only candidate metadata.
2. An LLM `refine-decision` node inspects the candidates and can request 1 to 3 more topics; the
   search loop is capped at 3 rounds (`_maxSearchIterations`).
3. The per-document loop calls `iFinder_getContent` for the current document only.
4. The extract prompt and JSON schema are identical to the upload variant.

When every candidate is processed, the cost equals the upload variant; when refinement prunes
candidates, the lazy variant is cheaper. Start it in a chat with
`@workflow stellungnahmen-review-ifinder` and give the focus prompt and the search profile id.

### Admin-driven corpus discovery

A precomputed corpus map (which sources contribute, which languages, typical titles) saves an agent
from discovering it at runtime. An admin endpoint runs a tool with admin context and writes the
result into an agent profile's long-term memory under the given heading:

```
POST /api/admin/agents/profiles/<profileId>/memory/from-tool
  { "toolId": "iFinder_discover",
    "params": { "searchProfile": "searchprofile-xyz", "query": "*:*" },
    "section": "iFinder corpus map",
    "mode": "replace-section" }
```

Later agent runs see the `## iFinder corpus map` section through the memory auto-include;
`stellungnahmen-review-ifinder` reads it when started with a non-empty `agentProfileId`. The endpoint
requires an admin. No default agent profile binds `iFinder_discover`, so agents cannot call it at
runtime. Re-run discovery when the index changes significantly.

## Security

- Every call runs as the signed-in user; iFinder enforces document permissions. There is no service
  account and anonymous users are refused.
- Tokens are short-lived (**Token lifetime**, default one hour; shorten it for production, for
  example `1800`).
- Prefer the keyless mode: there is no private key to store, distribute or rotate. With the legacy
  key, keep it in a credential or the environment, never in a file under version control, and rotate
  it (see [Legacy: manual key exchange](ifinder-oidc-jwt.md#legacy-manual-key-exchange)).
- Use HTTPS for iFinder. A private CA goes into `ssl.domainWhitelist`, never a global TLS bypass.
- Limit who can edit the installation (admins) and who may use it (`permissions.integrations`).
- Long documents are cut at `maxLength`.

## Troubleshooting

Start with **Test** on the installation (see [Testing the connection](#testing-the-connection)). The
two classic failures:

- **iFinder answers 500.** The request reached iFinder, so the cause is on its side, most often that
  iFinder cannot reach iHub's JWKS URL. Check the **Issuer reachable** step: an issuer of
  `localhost` or a single-label hostname can never work. Set the externally reachable URL under
  **Admin → Authentication → OAuth Server** and check it from the iFinder host with `curl`.
- **iFinder answers 401 with an empty body.** The diagnostics print the claims sent (`sub`, `iss`,
  `aud`, `alg`, `kid`) and any `WWW-Authenticate` header. Usual causes: an issuer that does not match
  exactly (a trailing slash is enough), a `kid` not in the JWKS, a subject in the wrong format, clock
  skew, or iFinder not configured to trust iHub at all.

| Message | Cause | Fix |
| --- | --- | --- |
| *iFinder access requires authenticated user* / *iFinder JWT requires authenticated user* | The user is anonymous | Sign in; check the authentication mode and session |
| *iFinder JWT subject could not be resolved: "JWT Subject Field" is set to …* | The user lacks the attribute **User identity sent to iFinder** names | Pick an attribute the user has, or supply it from the auth provider (for LDAP `domain\username`, the provider's **Domain** field) |
| *iFinder private key not configured* | Legacy mode without a key | Pick a **Private key** credential, set `IFINDER_PRIVATE_KEY`, or tick **Sign with iHub's OIDC key pair** |
| *iFinder private key must be in PEM format* | The key does not start with `-----BEGIN` | Paste the full PEM, including the `BEGIN`/`END` lines |
| *iFinder authentication failed. Please check JWT configuration.* | Token generation or validation failed | Run **Test**; check the key matches the public key in iFinder, the algorithm matches the key type (RS\* for RSA, ES\* for EC), and the issuer, audience and scope |
| *iFinder request timed out. Please try again.* | Network or slow iFinder | Raise **Request timeout (ms)**; check connectivity |
| *Document not found: …* | Wrong id, or the user lacks access | Search for the document and use the hit's `id`; check permissions in iFinder |
| `403 INTEGRATION_SCOPE_NOT_ALLOWED` | Search profile not available to the user or not on the allow-list | Check **Offered search profiles** and the user's profiles in iFinder |
| Search returns nothing for a filter | Filter on a field without `.keyword`, or wrong casing of a value | Use `getFields` and `getFacetValues` |
| *iFinder requires sign-in via …* and other token-exchange messages | Token exchange mode | See [Token exchange errors](ifinder-oidc-jwt.md#token-exchange-errors) |
| *Tool 'iassistant__ask' not found* | iAssistant installation missing, disabled or not bound | Check the installation is enabled, the app binds it with `ask`, and the user's group may use it |
| iAssistant model not found | `iassistant-conversation` missing or disabled | Make sure `contents/models/iassistant-conversation.json` exists with `"enabled": true` |

To follow a request in the server log, look for entries of component `IFinderService` ("Searching
for query in profile", "Fetching content for document") and `iFinderJwt` ("Generating iFinder JWT
for user …", which names the subject, scope and issuer). Raise `logging.level` to `debug` to see
the token payload and sign options.

## Quick reference

### Query cheat sheet

| Task | Write |
| --- | --- |
| Words, ranked | `query: "annual report"` |
| Exact phrase | `query: '"annual report"'` |
| One field | `query: 'title:budget'` |
| Exact value | `filter: ['creators.keyword:"DOE, John"']` |
| Date range | `filter: ['modificationDate:[2026-01-01 TO *]']` |
| Everything | `query: "*"` |
| Newest first | `sort: ["modificationDate:desc"]` |
| Value distribution | `returnFacets: ["sourceName.keyword"]` |
| Page 2 of 50 | `maxResults: 50, from: 50` |

Plain field name = analysed, for ranked matching; `.keyword` = exact value, for filters, facets and
sorting. `title`, `content`, `url` and `subject` have no `.keyword`.

### IntraFind operators

| Operator | Does |
| --- | --- |
| `MODE/e&Müller` | Exact: no lemma, compound or diacritic loosening |
| `MODE/c&Bundesligaspiel` | Decompound: also matches documents saying just "Liga" |
| `THES/&Stiefel` | Expand with thesaurus synonyms, broader and narrower terms |
| `ENTITY/PERS` | Any person name; also `LOC`, `ORG`, `EMAIL`, `PHONE` |
| `NEAR/S(vertrag kündigung)` | Both terms in one sentence (`P` paragraph, `5` within 5 tokens) |
| `UNIT/>=(5 kg)` | A weight over 5 kg written in the text, units converted |
| `DATE/>=(2026-01-01)` | A date in the text, however it is written |
| `NUMBER/[10 TO 100]` | A number in that range in the text |
| `OR/2(a b c d)` | OR group where at least 2 clauses must match |

### Setup checklist

1. Authentication set up on both sides ([iFinder Authentication](ifinder-oidc-jwt.md)).
2. iFinder installed with base URL, authentication, subject field and default profile; **Test**
   green.
3. Installation granted to the right groups.
4. Apps bind `ifinder` (and `iassistant`), or use the shipped **iFinder Search** app.
5. iAssistant installed on `ifinder`, `iassistant-conversation` model enabled, **Test** green.
