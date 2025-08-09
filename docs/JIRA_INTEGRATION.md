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
JIRA_OAUTH_CLIENT_ID=your-oauth-client-id
JIRA_OAUTH_CLIENT_SECRET=your-oauth-client-secret
JIRA_OAUTH_REDIRECT_URI=https://ihub.company.com/api/integrations/jira/callback

# Security Configuration
TOKEN_ENCRYPTION_KEY=your-256-bit-encryption-key-in-hex
```

### JIRA OAuth Application Setup

1. Go to your JIRA instance's Applications settings
2. Create a new OAuth2 application
3. Set the redirect URI to match your iHub Apps instance
4. Configure scopes: `read:jira-user`, `read:jira-work`, `write:jira-work`
5. Copy the Client ID and Client Secret to your environment variables

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

1. **First Use**: User attempts to use JIRA tool without connection
2. **Auth Prompt**: System shows connection prompt with "Connect to JIRA" button
3. **OAuth Flow**: User redirects to JIRA OAuth consent screen
4. **Token Storage**: Encrypted tokens stored for future use
5. **Tool Execution**: Original JIRA request executes seamlessly

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

### Architecture
- **JiraService**: Core service handling OAuth and API operations
- **Tool Wrapper**: Unified tool interface following iHub Apps patterns
- **Route Integration**: OAuth flow endpoints for authentication
- **Error Handling**: Comprehensive error responses with auth prompts

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

1. **"JIRA OAuth configuration incomplete"**
   - Ensure all environment variables are set
   - Verify JIRA OAuth application is properly configured

2. **"Authentication required"**
   - User needs to connect their JIRA account
   - Check if tokens have expired and need refresh

3. **"Permission denied"**
   - User doesn't have access to requested tickets
   - Verify user's JIRA permissions

4. **"Invalid JQL query"**
   - Check JQL syntax in search requests
   - Ensure user has permission to access queried fields

### Debug Mode
Enable debug logging by setting environment variable:
```bash
DEBUG=jira:*
```

## Compliance & Audit

- All JIRA operations appear in native JIRA audit logs
- User authentication preserves individual accountability
- No system-level access that bypasses user permissions
- Encrypted token storage meets enterprise security requirements
- Comprehensive logging for all integration activities