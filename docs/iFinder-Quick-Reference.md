# iFinder Integration - Quick Reference

## Quick Setup Checklist

### 1. Environment Variables
```bash
export IFINDER_API_URL="https://your-ifinder.com"
export IFINDER_SEARCH_PROFILE="default"  
export IFINDER_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
```

### 2. Test Configuration
```bash
# Start server and check logs for:
✓ Cached: config/tools.json
✅ Loaded ifinder-document-explorer (enabled)
```

### 3. Test User Authentication
- Anonymous users: ❌ Cannot access iFinder
- Authenticated users: ✅ Can search and access documents

## Tool Methods

| Method | Purpose | Required Params | Example |
|--------|---------|-----------------|---------|
| `iFinder.search` | Find documents | `query` | `{query: "contracts 2024"}` |
| `iFinder.getContent` | Get document text | `documentId` | `{documentId: "doc123"}` |
| `iFinder.getMetadata` | Get document info | `documentId` | `{documentId: "doc123"}` |
| `iFinder.download` | Download/save docs | `documentId` | `{documentId: "doc123", action: "save"}` |

## Common Error Messages

| Error | Meaning | Fix |
|-------|---------|-----|
| "iFinder search requires authenticated user" | User not logged in | Ensure user authentication |
| "iFinder authentication failed" | JWT issue | Check private key format |
| "Document not found" | Invalid document ID | Verify ID or search first |
| "Request timed out" | Network/performance | Increase `IFINDER_TIMEOUT` |

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
└── config/
    └── tools.json                # Tool definitions
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

- [Full iFinder Integration Documentation](iFinder-Integration.md)
- [Tools Documentation](tools.md)
- [Authentication Configuration](jwt-authentication.md)