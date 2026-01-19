# OAuth 2.0 Client Credentials - External API Authentication

**Date:** 2026-01-19  
**Status:** In Progress  
**Feature Type:** Authentication, Security, API Integration

## Overview

Implementation of OAuth 2.0 Client Credentials grant type to enable secure, programmatic API access for external applications and integrations. This allows third-party systems to authenticate and use our platform's API endpoints without user interaction.

## Goals

1. **Secure API Access**: Enable programmatic authentication for external integrators
2. **Standard Protocol**: Implement OAuth 2.0 Client Credentials (RFC 6749)
3. **Credential Management**: Support credential rotation without service interruption
4. **Granular Permissions**: Control which apps, models, and scopes each client can access
5. **Audit Trail**: Maintain comprehensive logs for security and compliance
6. **Admin Interface**: Provide API endpoints to manage OAuth clients
7. **Compatibility**: All endpoints (except admin) accessible via OAuth tokens
8. **Error Handling**: Proper RFC 6749 compliant error responses
9. **Static Tokens**: Support static API key generation for non-OAuth capable clients

## Architecture

### Component Structure

```
server/
├── middleware/
│   └── oauthAuth.js                 # OAuth token validation middleware
├── routes/
│   ├── oauth.js                     # OAuth token endpoints (/api/oauth/*)
│   └── admin/
│       └── oauthClients.js          # OAuth client management (/api/admin/oauth/*)
├── utils/
│   ├── oauthClientManager.js        # Client CRUD operations
│   └── oauthTokenService.js         # Token generation and validation
└── defaults/config/
    └── oauth-clients.json           # OAuth client storage template

contents/config/
└── oauth-clients.json               # Actual OAuth clients storage
```

### Data Models

#### OAuth Client Schema
```json
{
  "clients": {
    "client_abc123": {
      "id": "client_abc123",
      "name": "External Integration Name",
      "clientId": "client_abc123",
      "clientSecret": "encrypted_secret_hash",
      "description": "Purpose of this client",
      "scopes": ["chat", "models", "apps"],
      "allowedApps": ["app1", "app2"],
      "allowedModels": ["gpt-4", "claude-3"],
      "tokenExpirationMinutes": 60,
      "active": true,
      "createdAt": "2026-01-19T10:00:00Z",
      "createdBy": "admin_user_id",
      "lastUsed": "2026-01-19T12:30:00Z",
      "lastRotated": "2026-01-19T10:00:00Z",
      "metadata": {
        "ipWhitelist": [],
        "notes": "Additional notes"
      }
    }
  },
  "metadata": {
    "version": "1.0.0",
    "lastUpdated": "2026-01-19T10:00:00Z"
  }
}
```

#### JWT Token Payload (OAuth Client)
```json
{
  "sub": "client_abc123",
  "client_id": "client_abc123",
  "client_name": "External Integration Name",
  "scopes": ["chat", "models"],
  "allowedApps": ["app1"],
  "allowedModels": ["gpt-4"],
  "authMode": "oauth_client_credentials",
  "iat": 1705660800,
  "exp": 1705664400,
  "iss": "ihub-apps",
  "aud": "ihub-apps"
}
```

## API Endpoints

### OAuth Token Endpoints

#### POST /api/oauth/token
Generate access token using client credentials.

**Request:**
```json
{
  "grant_type": "client_credentials",
  "client_id": "client_abc123",
  "client_secret": "secret_xyz789",
  "scope": "chat models"  // Optional
}
```

**Response (200 OK):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "chat models"
}
```

#### POST /api/oauth/introspect
Introspect and validate a token.

**Request:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (200 OK):**
```json
{
  "active": true,
  "client_id": "client_abc123",
  "scopes": ["chat", "models"],
  "exp": 1705664400,
  "iat": 1705660800
}
```

### Admin Endpoints

#### POST /api/admin/oauth/clients
Create a new OAuth client.

**Request:**
```json
{
  "name": "External Integration",
  "description": "Integration for XYZ system",
  "scopes": ["chat", "models"],
  "allowedApps": ["app1"],
  "allowedModels": ["gpt-4"],
  "tokenExpirationMinutes": 60
}
```

#### GET /api/admin/oauth/clients
List all OAuth clients (secrets excluded).

#### GET /api/admin/oauth/clients/:clientId
Get specific client details.

#### PUT /api/admin/oauth/clients/:clientId
Update client configuration.

#### DELETE /api/admin/oauth/clients/:clientId
Delete OAuth client.

#### POST /api/admin/oauth/clients/:clientId/rotate-secret
Rotate client secret.

#### POST /api/admin/oauth/clients/:clientId/generate-token
Generate a static API key (long-lived token) for non-OAuth clients.

#### POST /api/admin/oauth/clients/:clientId/introspect-token
Introspect a specific client's token.

## Error Responses (RFC 6749)

All OAuth errors follow RFC 6749 format:

```json
{
  "error": "error_code",
  "error_description": "Human-readable description"
}
```

| HTTP Status | Error Code | When |
|-------------|------------|------|
| 400 | invalid_request | Malformed request |
| 400 | invalid_grant | Wrong grant_type |
| 400 | invalid_scope | Unknown or unauthorized scope |
| 401 | invalid_client | Bad credentials |
| 401 | invalid_token | Token missing, malformed, or invalid signature |
| 401 | token_expired | Token has expired |
| 403 | access_denied | Client suspended |
| 403 | insufficient_scope | Token lacks required scope |

## Security Features

### Encrypted Storage
- Client secrets stored using bcrypt hashing
- Secrets never returned in API responses
- Only displayed once at creation time

### Secret Rotation
- Zero-downtime rotation supported
- Old secret remains valid during grace period (configurable)
- Audit log tracks all rotation events

### Audit Logging
All OAuth operations are logged with:
- **Timestamp**: When the operation occurred
- **Client ID**: Which client performed the operation
- **Operation**: What action was taken
- **Result**: Success or failure
- **IP Address**: Source of the request
- **User Agent**: Client application identifier

Example log entry:
```
[2026-01-19 12:30:45] [OAuth] Token issued | client_id=client_abc123 | scopes=chat,models | ip=192.168.1.100 | expires_in=3600
```

### Permission Enforcement
- Scope validation on every request
- App-level access control
- Model-level access control
- Client suspension support

## Integration with Existing Auth

### Middleware Chain
The OAuth middleware integrates into the existing auth chain:

```javascript
app.use(
  createAuthChain([
    proxyAuth,              // Step 1: Proxy headers
    teamsAuthMiddleware,    // Step 2: Teams auth
    jwtAuthMiddleware,      // Step 3: JWT validation (enhanced for OAuth)
    oauthAuthMiddleware,    // Step 4: OAuth client credentials
    localAuthMiddleware,    // Step 5: Local auth
    ldapAuthMiddleware,     // Step 6: LDAP auth
    ntlmAuthMiddleware      // Step 7: NTLM auth
  ])
);
```

### Token Reuse
- Reuses existing JWT infrastructure
- Extends `tokenService.js` with OAuth-specific claims
- Leverages existing `jwtAuth.js` middleware for validation

## Usage Examples

### cURL Example
```bash
# Get access token
curl -X POST https://ihub.example.com/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "client_abc123",
    "client_secret": "secret_xyz789"
  }'

# Use token to call API
curl -X POST https://ihub.example.com/api/chat/completions \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Node.js Example
```javascript
const axios = require('axios');

async function getToken() {
  const response = await axios.post('https://ihub.example.com/api/oauth/token', {
    grant_type: 'client_credentials',
    client_id: 'client_abc123',
    client_secret: 'secret_xyz789'
  });
  return response.data.access_token;
}

async function callAPI() {
  const token = await getToken();
  const response = await axios.post(
    'https://ihub.example.com/api/chat/completions',
    {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }]
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}
```

## Incident Response

### If a Secret is Stolen

1. **Immediate Action**: Suspend the client via admin interface
   ```bash
   PUT /api/admin/oauth/clients/:clientId
   { "active": false }
   ```

2. **Rotate Secret**: Generate new credentials
   ```bash
   POST /api/admin/oauth/clients/:clientId/rotate-secret
   ```

3. **Audit Review**: Check audit logs for unauthorized access
   ```bash
   grep "client_id=client_abc123" /var/log/ihub-apps/oauth-audit.log
   ```

4. **Update Client**: Provide new credentials to legitimate users

5. **Re-enable**: Activate client with new credentials
   ```bash
   PUT /api/admin/oauth/clients/:clientId
   { "active": true }
   ```

## Files Modified/Created

### New Files
- `server/middleware/oauthAuth.js` - OAuth authentication middleware
- `server/routes/oauth.js` - OAuth token endpoints
- `server/routes/admin/oauthClients.js` - Admin OAuth client management
- `server/utils/oauthClientManager.js` - Client CRUD operations
- `server/utils/oauthTokenService.js` - OAuth-specific token operations
- `server/defaults/config/oauth-clients.json` - Default OAuth clients template
- `docs/oauth-integration-guide.md` - Integration documentation

### Modified Files
- `server/middleware/jwtAuth.js` - Enhanced to support OAuth tokens
- `server/utils/tokenService.js` - Extended with OAuth token generation
- `server/server.js` - Register OAuth routes
- `shared/i18n/en.json` - English translations
- `shared/i18n/de.json` - German translations

## Configuration

Add to `contents/config/platform.json`:

```json
{
  "oauth": {
    "enabled": true,
    "clientsFile": "contents/config/oauth-clients.json",
    "defaultTokenExpirationMinutes": 60,
    "maxTokenExpirationMinutes": 1440,
    "secretRotationGracePeriodDays": 7,
    "auditLog": {
      "enabled": true,
      "logFile": "logs/oauth-audit.log"
    }
  }
}
```

## Testing Checklist

- [ ] Token generation with valid credentials
- [ ] Token rejection with invalid credentials
- [ ] Token expiration handling
- [ ] Scope validation
- [ ] App/model permission enforcement
- [ ] Client suspension enforcement
- [ ] Secret rotation with grace period
- [ ] Audit log completeness
- [ ] Admin API authorization
- [ ] Error response format compliance
- [ ] Static API key generation
- [ ] Introspection endpoint

## Implementation Status

**Phase 1**: Core Infrastructure - In Progress  
**Phase 2**: Token Service - Not Started  
**Phase 3**: Authentication Routes - Not Started  
**Phase 4**: Middleware Integration - Not Started  
**Phase 5**: Admin Interface - Not Started  
**Phase 6**: Audit & Logging - Not Started  
**Phase 7**: Documentation - Not Started  
**Phase 8**: Internationalization - Not Started  
**Phase 9**: Testing & Validation - Not Started

## Related Documents

- RFC 6749: The OAuth 2.0 Authorization Framework
- `docs/authentication-architecture.md` - Existing auth architecture
- `docs/external-authentication.md` - External auth documentation
