# iFinder Integration - Quick Reference

## Recommended: Keyless (OIDC/OAuth) Setup

No key generation, no key exchange. iHub signs with its OIDC key; iFinder
verifies via iHub's JWKS endpoint. Full guide:
[iFinder Keyless (OIDC/OAuth) JWT Integration](ifinder-oidc-jwt.md).

**iHub** (`platform.json` or Admin → iFinder Integration):

```json
{
  "oauth": { "issuer": "https://your-ihub.com" },
  "iFinder": { "enabled": true, "baseUrl": "https://your-ifinder.com", "useOidcKeyPair": true }
}
```

`oauth.issuer` must be your iHub public URL (used as the token `iss`; not auto-detected at signing time).

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

...or, from Admin > Credentials, create a "Secret" credential holding the PEM
key and select it in Admin > Integrations > iFinder's **Private Key** field
(stored as `iFinder.privateKeyRef`). The env var takes precedence when both
are set.

### 2. Test Configuration

```bash
# Start server and check logs for:
✓ Cached: contents/tools/*.json
✅ Loaded ifinder-document-explorer (enabled)
```

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
| "Request timed out"                          | Network/performance | Increase `IFINDER_TIMEOUT` |

## File Structure

```
server/
├── tools/
│   └── iFinder.js                 # Unified iFinder tool
├── utils/
│   └── iFinderJwt.js             # JWT token generation
contents/
├── apps/
│   └── ifinder-document-explorer.json  # App configuration
└── tools/
    └── iFinder.json                   # Tool definition
docs/
├── iFinder-Integration.md        # Full documentation
└── iFinder-Quick-Reference.md    # This file
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

1. Environment variables (`IFINDER_*`)
2. `platform.json` → `iFinder` section
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
