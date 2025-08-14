# JIRA Connector Integration

The JIRA Connector provides comprehensive integration with Atlassian JIRA, enabling AI assistants to search, read, and manage JIRA tickets on behalf of users.

## Features

### Core Functionality
- **Search Tickets**: Search and list JIRA tickets using JQL queries
- **Ticket Details**: Retrieve detailed ticket information including comments and history
- **Comment Management**: Add comments to tickets with user confirmation
- **Status Management**: Get available transitions and change ticket status
- **Attachment Access**: Download and access ticket attachments
- **User-Scoped Access**: Users can only access tickets they have permissions for

### Security & Authentication
- **OAuth2 PKCE Flow**: Secure user authentication with JIRA
- **Encrypted Token Storage**: AES-256-GCM encryption for stored tokens
- **Automatic Token Refresh**: Seamless token renewal for uninterrupted access
- **Permission Inheritance**: Respects user's native JIRA permissions
- **Audit Trail**: All operations performed in user's name for compliance

## Configuration

### Environment Variables

```bash
# JIRA OAuth Configuration
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_OAUTH_CLIENT_ID=your-oauth-client-id-from-console
JIRA_OAUTH_CLIENT_SECRET=your-oauth-client-secret-from-console
JIRA_OAUTH_REDIRECT_URI=https://ihub.company.com/api/integrations/jira/callback

# For development:
# JIRA_OAUTH_REDIRECT_URI=http://localhost:5173/api/integrations/jira/callback

# Security Configuration
TOKEN_ENCRYPTION_KEY=your-256-bit-encryption-key-in-hex
```

### Atlassian OAuth Application Setup

1. **Go to Atlassian Developer Console**: 
   - Navigate to [https://developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/)
   - Sign in with your Atlassian account

2. **Create OAuth 2.0 (3LO) App**:
   - Click "Create" → "OAuth 2.0 integration"
   - **App Type**: OAuth 2.0 (3LO)
   - **App Name**: iHub Apps JIRA Integration
   - **App Description**: AI-powered JIRA integration for iHub Apps

3. **Configure Authorization**:
   - **Callback URL**: Add your redirect URI
     - Development: `http://localhost:5173/api/integrations/jira/callback`
     - Production: `https://your-domain.com/api/integrations/jira/callback`
   - **Permissions/Scopes**: 
     - `read:jira-user` - Access user profile information
     - `read:jira-work` - Read issues, projects, comments
     - `write:jira-work` - Create/update issues, add comments
     - `offline_access` - Required for refresh tokens

4. **Save Credentials**:
   - Copy the **Client ID** → `JIRA_OAUTH_CLIENT_ID`
   - Copy the **Client Secret** → `JIRA_OAUTH_CLIENT_SECRET`

5. **Important OAuth2 Settings**:
   - The integration uses Atlassian's centralized OAuth endpoints:
     - Authorization: `https://auth.atlassian.com/authorize`
     - Token: `https://auth.atlassian.com/oauth/token`
   - API calls use: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/`

## Usage

### Available Functions

#### searchTickets
Search for JIRA tickets using JQL queries.

```javascript
{
  "jql": "assignee = currentUser() AND status = Open",
  "maxResults": 50
}
```

#### getTicket
Get detailed information about a specific ticket.

```javascript
{
  "issueKey": "PROJ-123",
  "includeComments": true
}
```

#### addComment
Add a comment to a ticket (requires confirmation).

```javascript
{
  "issueKey": "PROJ-123",
  "comment": "Updated the documentation as requested",
  "requireConfirmation": true
}
```

#### getTransitions
Get available status transitions for a ticket.

```javascript
{
  "issueKey": "PROJ-123"
}
```

#### transitionTicket
Change the status of a ticket (requires confirmation).

```javascript
{
  "issueKey": "PROJ-123",
  "transitionId": "21",
  "comment": "Issue resolved",
  "requireConfirmation": true
}
```

#### getAttachment
Download ticket attachments.

```javascript
{
  "attachmentId": "12345",
  "returnBase64": false
}
```

## Authentication Flow

### OAuth 2.0 Flow Details

1. **Initial Request**: User attempts to use JIRA tool without connection
2. **Auth Prompt**: System shows connection prompt with "Connect to JIRA" button
3. **OAuth Initiation**: 
   - Generates PKCE code verifier and challenge for enhanced security
   - Redirects to: `https://auth.atlassian.com/authorize`
   - Required parameters:
     - `audience=api.atlassian.com` (mandatory for Atlassian Cloud)
     - `prompt=consent` (ensures offline_access is granted)
     - `access_type=offline` (requests refresh token)
4. **User Authorization**: 
   - User logs into Atlassian account
   - Grants permissions to iHub Apps
   - Must approve offline_access for automatic token refresh
5. **Token Exchange**: 
   - Callback receives authorization code
   - Exchanges code for tokens at `https://auth.atlassian.com/oauth/token`
   - Receives access token (1 hour) and refresh token
6. **Token Storage**: 
   - Tokens encrypted using AES-256-GCM
   - Stored in `contents/integrations/jira/`
   - Automatic refresh before expiration
7. **API Access**: 
   - Discovers user's cloudId from accessible resources
   - Makes API calls to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/`
8. **Tool Execution**: Original JIRA request executes seamlessly

## Error Handling

The JIRA connector provides comprehensive error handling:

- **JIRA_AUTH_REQUIRED**: User needs to connect JIRA account
- **Authentication Expired**: Automatic token refresh or re-authentication prompt
- **Permission Denied**: Clear messages about access limitations
- **API Errors**: Meaningful error messages from JIRA API
- **Network Issues**: Graceful handling of connectivity problems

## Security Features

- **User Context**: All operations performed with user's JIRA permissions
- **No Privilege Escalation**: Users limited to their normal JIRA access
- **Encrypted Storage**: Tokens encrypted at rest using AES-256-GCM
- **Automatic Cleanup**: Expired tokens automatically refreshed or removed
- **Audit Compliance**: Native JIRA audit trail shows actual user actions

## Implementation Details

### Technical Architecture

#### Core Components
- **JiraService**: Core service handling OAuth and API operations
- **TokenStorageService**: Centralized encrypted token management
- **Tool Wrapper**: Unified tool interface following iHub Apps patterns
- **Route Integration**: OAuth flow endpoints for authentication
- **Error Handling**: Comprehensive error responses with auth prompts

#### Key Technical Details
- **PKCE Support**: Implements Proof Key for Code Exchange for enhanced security
- **API Version**: Uses JIRA REST API v3 (latest stable version)
- **Cloud Gateway**: All API calls routed through `api.atlassian.com`
- **Session Isolation**: Integration sessions separate from user auth sessions
- **Token Refresh**: Automatic refresh with 2-minute buffer before expiration
- **Encryption**: AES-256-GCM for token storage with context-aware keys

### Files Structure
```
server/
├── services/integrations/JiraService.js    # Core JIRA service
├── tools/jira.js                           # Tool wrapper
└── routes/integrations/jira.js             # OAuth routes

contents/
├── config/tools.json                       # Tool configuration
└── integrations/jira/                      # Token storage (encrypted)
```

## Troubleshooting

### Common Issues

#### 1. OAuth Configuration Issues

**"JIRA OAuth configuration incomplete"**
- Ensure all environment variables are set correctly
- Verify OAuth app is created in Atlassian Developer Console (not JIRA instance)
- Check that redirect URI matches exactly (including protocol and port)

**404 Error on Authorization**
- ❌ Wrong: `https://your-site.atlassian.net/oauth/authorize`
- ✅ Correct: `https://auth.atlassian.com/authorize`
- Ensure using Atlassian's centralized OAuth endpoints

**Missing `audience` Parameter**
- The `audience=api.atlassian.com` parameter is mandatory
- Without it, Atlassian will reject the authorization request

#### 2. Token Refresh Issues

**No Refresh Token Received**
- **Problem**: Users need to reconnect every hour
- **Symptoms**: 
  - Server logs: `No refresh token available - user needs to reconnect`
  - Token data missing `refreshToken` field
- **Causes**:
  - App not configured for offline access in Atlassian
  - User denied offline_access during consent
  - `offline_access` scope not included in request
- **Solutions**:
  - Ensure `offline_access` scope is in OAuth request
  - User must grant all permissions during authorization
  - Check app has offline access enabled in Developer Console
  - Re-authenticate with proper consent

**Token Expiration Handling**
- Tokens expire after 1 hour
- System refreshes automatically with 2-minute buffer
- If refresh fails, user must reconnect

#### 3. API Access Issues

**"Permission denied"**
- User doesn't have access to requested JIRA resources
- Verify user's JIRA permissions in JIRA admin
- Check if user can access the resource directly in JIRA

**"Invalid JQL query"**
- Verify JQL syntax is correct
- Ensure fields exist and user has permission to query them
- Test query directly in JIRA's issue search

**CloudId Discovery Failed**
- User may not have access to any JIRA sites
- Check user is part of at least one Atlassian site
- Verify OAuth app is installed on the JIRA instance

#### 4. Connection Issues

**SSL/TLS Errors**
- Verify network allows HTTPS to:
  - `https://auth.atlassian.com`
  - `https://api.atlassian.com`
  - Your JIRA instance URL

**Rate Limiting**
- Default: 100 requests per 15 minutes per user
- Monitor server logs for rate limit warnings
- Adjust `JIRA_RATE_LIMIT_*` environment variables if needed

### Testing the Integration

1. **Start Development Server**: 
   ```bash
   npm run dev
   ```

2. **Navigate to JIRA Assistant**: 
   ```
   http://localhost:5173/apps/jira-assistant
   ```

3. **Test Connection**:
   - Ask: "Show me my assigned tickets"
   - Connection prompt should appear
   - Click "Connect JIRA Account"
   - Complete OAuth flow
   - Tickets should display

### Debug Mode

Enable detailed logging:
```bash
# In your .env file
DEBUG=jira:*

# Or when starting the server
DEBUG=jira:* npm run dev
```

Monitor server console for:
- OAuth flow details
- Token refresh attempts
- API request/response data
- Error details with stack traces

## Compliance & Audit

- All JIRA operations appear in native JIRA audit logs
- User authentication preserves individual accountability
- No system-level access that bypasses user permissions
- Encrypted token storage meets enterprise security requirements
- Comprehensive logging for all integration activities

## Important Implementation Notes

### Atlassian Cloud vs Server/Data Center
- This integration is designed for **Atlassian Cloud** (SaaS)
- Uses OAuth 2.0 (3LO) - Three-Legged OAuth
- Not compatible with JIRA Server or Data Center (on-premise)
- Server/DC would require different authentication (Basic Auth, OAuth 1.0a, or PAT)

### Known Limitations
- **Token Refresh**: Some Atlassian configurations may not provide refresh tokens despite requesting `offline_access`. This is a known Atlassian limitation.
- **PKCE Support**: Atlassian Cloud may not fully honor PKCE parameters, but the implementation includes them for compatibility
- **Rate Limits**: JIRA APIs have rate limits that vary by endpoint and subscription tier
- **Attachment Size**: Large attachments may timeout or exceed memory limits

### Best Practices
1. **Always request `offline_access`** scope for refresh tokens
2. **Monitor token refresh logs** to identify authentication issues early
3. **Test OAuth flow** after any Atlassian app configuration changes
4. **Keep redirect URIs synchronized** between environments and Atlassian console
5. **Use production encryption keys** - never reuse development keys in production