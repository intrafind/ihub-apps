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

### 1. Environment Variables

```bash
export IFINDER_API_URL="https://your-ifinder.com"
export IFINDER_SEARCH_PROFILE="default"
export IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
```

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

| Method                | Purpose            | Required Params | Example                                  |
| --------------------- | ------------------ | --------------- | ---------------------------------------- |
| `iFinder.search`      | Find documents     | `query`         | `{query: "contracts 2024"}`              |
| `iFinder.getContent`  | Get document text  | `documentId`    | `{documentId: "doc123"}`                 |
| `iFinder.getMetadata` | Get document info  | `documentId`    | `{documentId: "doc123"}`                 |
| `iFinder.download`    | Download/save docs | `documentId`    | `{documentId: "doc123", action: "save"}` |

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
