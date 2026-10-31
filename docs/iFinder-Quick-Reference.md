# iFinder Integration - Quick Reference

## Recommended: Keyless (OIDC/OAuth) Setup

No key generation, no key exchange. iHub signs with its OIDC key; iFinder
verifies via iHub's JWKS endpoint. Full guide:
[iFinder Keyless (OIDC/OAuth) JWT Integration](ifinder-oidc-jwt.md).

**iHub:** install iFinder under **Admin → Integrations → Installed → iFinder**
with the base URL and **Sign with iHub's OIDC key pair** ticked. The
installation in `contents/config/integrations.json`:

```json
{ "id": "ifinder", "definition": "com.intrafind/ifinder", "enabled": true,
  "values": { "baseUrl": "https://your-ifinder.com", "useOidcKeyPair": true } }
```

`oauth.issuer` in `platform.json` (Admin → Authentication → OAuth Server) must be your iHub public URL (used as the token `iss`; not auto-detected at signing time).

**iFinder** (Spring Boot):

```yaml
intrafind.security.auth.enable-oauth2-resource-server: true
spring.security.oauth2.resourceserver.jwt.issuer-uri: https://your-ihub.com
spring.security.oauth2.resourceserver.jwt.principal-claim-name: email
```

## Legacy Setup Checklist (manual key exchange)

### 1. Private Key

Either set the environment variable:

```bash
export IFINDER_API_URL="https://your-ifinder.com"
export IFINDER_SEARCH_PROFILE="default"
export IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
```

...or, from Admin → Credentials, create a "Secret" credential holding the PEM
key and select it in the **Private key** field of the iFinder installation
(Admin → Integrations → Installed → iFinder; stored as `privateKeyRef` in its
values). The env var takes precedence when both are set.

### 2. Test Configuration

Click **Test** on the iFinder installation under **Admin → Integrations →
Installed**: it checks DNS, TLS, the JWT and a real search request, step by
step.

### 3. Test User Authentication

- Anonymous users: ❌ Cannot access iFinder
- Authenticated users: ✅ Can search and access documents

## Tool Methods

| Method                   | Purpose                  | Required Params | Example                                      |
| ------------------------ | ------------------------ | --------------- | -------------------------------------------- |
| `iFinder.search`         | Find documents           | `query`         | `{query: "contracts 2024"}`                  |
| `iFinder.getContent`     | Get document text        | `documentId`    | `{documentId: "doc123"}`                     |
| `iFinder.getMetadata`    | Get document info        | `documentId`    | `{documentId: "doc123"}`                     |
| `iFinder.download`       | Download/save docs       | `documentId`    | `{documentId: "doc123", action: "save"}`     |
| `iFinder.getFields`      | Field catalog            | —               | `{filterPrefix: "cust."}`                    |
| `iFinder.getFacetValues` | Enumerate a facet        | `facet`         | `{facet: "application.keyword"}`             |
| `iFinder.listProfiles`   | Reachable search profiles | —              | `{}`                                         |
| `iFinder.discover`       | Probe a profile          | `searchProfile` | `{searchProfile: "searchprofile-standard"}`  |

## Query Cheat Sheet

| Task                | Write                                              |
| ------------------- | -------------------------------------------------- |
| Words, ranked       | `query: "annual report"`                            |
| Exact phrase        | `query: '"annual report"'`                          |
| One field           | `query: 'title:budget'`                             |
| Exact value         | `filter: ['creators.keyword:"DOE, John"']`          |
| Date range          | `filter: ['modificationDate:[2026-01-01 TO *]']`    |
| Everything          | `query: "*"`                                        |
| Newest first        | `sort: ["modificationDate:desc"]`                   |
| Value distribution  | `returnFacets: ["sourceName.keyword"]`              |
| Page 2 of 50        | `maxResults: 50, from: 50`                          |

## IntraFind Operators

Beyond Lucene, the query accepts IntraFind operators (in `query` and `filter`):

| Operator                    | Does                                                    |
| --------------------------- | ------------------------------------------------------- |
| `NEAR/S(vertrag kündigung)` | Both terms in one sentence (`P` paragraph, `5` N tokens) |
| `MODE/e&Müller`             | Exact — no lemma/compound/diacritic loosening            |
| `MODE/c&Bundesligaspiel`    | Decompound — also matches "Liga"                         |
| `THES/&Stiefel`             | Thesaurus synonyms, broader and narrower terms           |
| `ENTITY/PERS`               | Any person name — also `LOC`, `ORG`, `EMAIL`, `PHONE`    |
| `UNIT/>=(5 kg)`             | A weight over 5 kg in the text, units converted          |
| `DATE/>=(2026-01-01)`       | A date in the text, however written                      |
| `NUMBER/[10 TO 100]`        | A number in that range in the text                       |
| `OR/2(a b c d)`             | OR group, at least 2 clauses must match                  |

Booleans also accept `UND` / `ODER` / `NICHT`. A field prefix goes in front:
`content:NEAR/S(ENTITY/PERS AND Kündigungsfrist)`. These are normally active,
but a deployment can switch them off — an unknown operator becomes a literal
term and matches nothing, so compare `totalFound` with and without it.

**`.keyword` rule.** Plain name = analyzed, for relevance-ranked matching.
`.keyword` = exact value, for filters, facets and sorting. Dates, numbers and
booleans take no suffix; `title`, `content`, `url` and `subject` have no
`.keyword` at all, so a filter on them silently matches nothing. Call
`iFinder.getFields` when unsure — it reports the right name per purpose.

## Common Error Messages

| Error                                        | Meaning             | Fix                        |
| -------------------------------------------- | ------------------- | -------------------------- |
| "iFinder search requires authenticated user" | User not logged in  | Ensure user authentication |
| "iFinder authentication failed"              | JWT issue           | Check private key format   |
| "Document not found"                         | Invalid document ID | Verify ID or search first  |
| "Request timed out"                          | Network/performance | Raise the installation's request timeout |

## File Structure

```
server/
├── defaults/integration-definitions/
│   ├── com.intrafind__ifinder/       # Built-in iFinder definition (install fields, actions)
│   └── com.intrafind__iassistant/    # Built-in iAssistant definition
├── services/integrations/
│   ├── ifinderConfig.js              # The installations' values as the code reads them
│   └── protocols/native/connectors/  # iFinder and iAssistant connectors (the tools, Test)
├── migrations/
│   └── V192__ifinder_iassistant_installed_integrations.js  # platform.json → installations
└── utils/
    └── iFinderJwt.js                 # JWT token generation
contents/
├── config/
│   └── integrations.json             # The ifinder and iassistant installations
└── apps/
    └── ifinder-search.json           # Shipped app, binds the ifinder installation
docs/
├── iFinder-Integration.md            # Full documentation
└── iFinder-Quick-Reference.md        # This file
```

## Development Commands

```bash
# Test server startup
npm run dev

# Check tool loading
grep "iFinder" server.log

# Test JWT generation
node -e "
const jwt = require('./server/utils/iFinderJwt.js');
console.log(jwt.generateIFinderJWT({id: 'test', email: 'test@example.com'}));
"
```

## Configuration Priority

1. Environment variables (`IFINDER_API_URL`, `IFINDER_PRIVATE_KEY`; `IFINDER_SEARCH_PROFILE` only while the installation's default profile is empty)
2. The `ifinder` installation in `contents/config/integrations.json` (Admin → Integrations → Installed)
3. Default values

## Key Implementation Details

- **Authentication**: User-based JWT tokens with RS256 signing
- **User Context**: All operations use authenticated user's permissions
- **Error Handling**: Consistent error handling across all methods
- **Configuration**: Single source of truth with fallback hierarchy
- **Tool Structure**: Method-based exports like `entraPeopleSearch.js`

## See Also

- [iFinder Keyless (OIDC/OAuth) JWT Integration](ifinder-oidc-jwt.md)
- [Full iFinder Integration Documentation](iFinder-Integration.md)
- [Tools Documentation](tools.md)
- [Authentication Configuration](jwt-authentication.md)
