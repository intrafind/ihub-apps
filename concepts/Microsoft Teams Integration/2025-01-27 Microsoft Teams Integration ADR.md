# Microsoft Teams Integration - Architecture Decision Record (ADR)

## Status

Proposed

## Context

AI Hub Apps needs to integrate with Microsoft Teams to provide users with seamless access to AI capabilities within their primary collaboration platform. The integration must maintain the existing AI Hub Apps architecture while adding Teams-specific functionality.

## Decision

### Overall Architecture Pattern

We will implement a **Hybrid Integration Architecture** that combines:

- Embedded bot service within the existing AI Hub Apps Node.js server
- Reuse of existing authentication and API infrastructure
- Teams-specific adapters for protocol translation
- Minimal changes to the existing codebase

### Component Architecture

```
┌─────────────────────┐
│   Microsoft Teams   │
│      Client         │
└──────────┬──────────┘
           │ HTTPS/WebSocket
           │
┌──────────┴──────────┐
│   Teams Platform    │
│   (Bot Service)     │
└──────────┬──────────┘
           │
┌──────────┴──────────┐
│  AI Hub Apps Server │
│  ┌────────────────┐ │
│  │  Teams Module  │ │
│  │  - Bot Handler │ │
│  │  - Tab Auth    │ │
│  │  - Msg Ext     │ │
│  └───────┬────────┘ │
│          │          │
│  ┌───────┴────────┐ │
│  │  Core Services │ │
│  │  - Auth        │ │
│  │  - Chat        │ │
│  │  - Config      │ │
│  └────────────────┘ │
└─────────────────────┘
```

### Key Architectural Decisions

#### 1. Bot Framework Integration

- **Decision**: Use Microsoft Bot Framework SDK for Node.js
- **Rationale**:
  - Native Teams integration with full feature support
  - Handles protocol complexities automatically
  - Supports all Teams surfaces (chat, channels, meetings)
- **Implementation**: New module at `server/teams/`

#### 2. Authentication Strategy

- **Decision**: Dual authentication with SSO bridge
- **Rationale**:
  - Leverage existing AI Hub Apps auth system
  - Add Teams SSO for seamless experience
  - Map Teams users to AI Hub Apps users
- **Implementation**:
  ```javascript
  // Pseudo-code for auth bridge
  class TeamsAuthBridge {
    async authenticateTeamsUser(teamsContext) {
      const teamsUser = await this.validateTeamsToken(teamsContext.token);
      const aiHubUser = await this.mapOrCreateUser(teamsUser);
      return this.generateAIHubToken(aiHubUser);
    }
  }
  ```

#### 3. Message Processing Pipeline

- **Decision**: Event-driven adapter pattern
- **Rationale**:
  - Decouple Teams-specific logic from core AI logic
  - Enable future platform integrations
  - Maintain single source of truth for AI processing
- **Implementation**:
  ```javascript
  // Teams Adapter
  class TeamsAdapter {
    async processActivity(activity) {
      const aiHubRequest = this.translateToAIHub(activity);
      const response = await this.aiHubService.process(aiHubRequest);
      return this.translateToTeams(response);
    }
  }
  ```

#### 4. State Management

- **Decision**: Hybrid state with Teams conversation reference
- **Rationale**:
  - Maintain conversation context across platforms
  - Enable cross-platform conversation continuity
  - Respect Teams data retention policies
- **Storage**: Existing AI Hub Apps database with Teams metadata

#### 5. Deployment Architecture

- **Decision**: Single deployment with Teams module
- **Rationale**:
  - Simplify operations and maintenance
  - Share resources and reduce costs
  - Maintain consistent versioning
- **Configuration**: Environment-based Teams enablement

### Technical Implementation Details

#### Bot Service Structure

```
server/
├── teams/
│   ├── index.js           # Main Teams module entry
│   ├── bot.js             # Bot handler implementation
│   ├── auth/
│   │   ├── sso.js         # Teams SSO implementation
│   │   └── bridge.js      # Auth system bridge
│   ├── handlers/
│   │   ├── message.js     # Message activity handler
│   │   ├── command.js     # Command processor
│   │   └── card.js        # Adaptive card handler
│   ├── extensions/
│   │   ├── compose.js     # Compose extensions
│   │   └── message.js     # Message extensions
│   └── manifest/
│       └── manifest.json  # Teams app manifest
```

#### API Extensions

```javascript
// Extend existing routes
router.post('/api/teams/messages', teamsAuth, async (req, res) => {
  const { activity } = req.body;
  const response = await teamsBot.processActivity(activity);
  res.json(response);
});

router.get('/api/teams/tab/config', teamsAuth, async (req, res) => {
  const config = await getTeamsTabConfig(req.user);
  res.json(config);
});
```

#### Configuration Schema Extension

```json
{
  "teams": {
    "enabled": true,
    "appId": "${TEAMS_APP_ID}",
    "appPassword": "${TEAMS_APP_PASSWORD}",
    "features": {
      "bot": true,
      "tab": true,
      "messaging": true,
      "meetings": false // Phase 2
    },
    "permissions": {
      "mapToGroups": {
        "TeamOwners": "admin",
        "TeamMembers": "users"
      }
    }
  }
}
```

### Security Considerations

#### Token Validation

- Validate all Teams tokens using Microsoft's public keys
- Implement token refresh for long-running conversations
- Cache validated tokens with appropriate TTL

#### Data Isolation

- Separate Teams-specific data from core AI Hub data
- Implement tenant isolation for multi-tenant scenarios
- Respect Teams data governance policies

#### Rate Limiting

- Implement Teams-specific rate limiting
- Use exponential backoff for Teams API calls
- Cache frequently accessed data

### Performance Optimizations

#### Caching Strategy

- Cache user mappings (Teams ID -> AI Hub ID)
- Cache app manifests and configurations
- Implement Redis-based distributed cache for scale

#### Connection Pooling

- Reuse Bot Framework adapter instances
- Maintain persistent WebSocket connections
- Implement connection health monitoring

#### Response Streaming

- Stream long AI responses using Teams typing indicators
- Chunk large responses into multiple messages
- Implement progress cards for long-running operations

### Monitoring and Observability

#### Metrics

- Teams-specific endpoints in existing metrics
- Track bot usage patterns and response times
- Monitor authentication success/failure rates

#### Logging

- Structured logging with Teams context
- Correlation IDs across platforms
- PII redaction for Teams data

#### Health Checks

- Teams connectivity health endpoint
- Bot registration validation
- Authentication flow testing

### Migration Strategy

#### Phase 1: Read-Only Integration

- Deploy bot with query capabilities only
- Implement personal tab with existing UI
- Gather usage metrics and feedback

#### Phase 2: Full Integration

- Enable write operations through bot
- Add message extensions
- Implement meeting integration

#### Phase 3: Advanced Features

- Custom AI apps for Teams
- Voice integration
- Advanced analytics

### Alternatives Considered

#### 1. Separate Teams Microservice

- **Pros**: Complete isolation, independent scaling
- **Cons**: Complex deployment, data synchronization issues
- **Reason for rejection**: Unnecessary complexity for current scale

#### 2. Teams-Only Deployment

- **Pros**: Optimized for Teams, simpler codebase
- **Cons**: Duplicate functionality, maintenance burden
- **Reason for rejection**: Violates DRY principle

#### 3. Third-Party Integration Platform

- **Pros**: Faster implementation, less code
- **Cons**: Vendor lock-in, limited customization
- **Reason for rejection**: Doesn't meet security requirements

## Consequences

### Positive

- Unified codebase with shared business logic
- Leverages existing authentication and authorization
- Minimal operational overhead
- Easy to maintain feature parity

### Negative

- Increased complexity in main application
- Teams-specific code in core repository
- Potential performance impact on non-Teams users
- Teams platform dependency

### Mitigations

- Feature flags for Teams-specific functionality
- Lazy loading of Teams modules
- Comprehensive testing strategy
- Clear architectural boundaries
