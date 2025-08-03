# Sources Admin Interface Implementation Plan

## Executive Summary

This document outlines the technical implementation plan for extending the AI Hub Apps admin interface to support comprehensive sources configuration management. The implementation will enable administrators to configure, manage, and monitor source handlers (filesystem, URL, iFinder) through a web-based interface, reducing dependency on manual JSON configuration.

### Business Value

- **Operational Efficiency**: Reduce configuration complexity and eliminate manual JSON editing
- **Error Reduction**: Provide validation and guided configuration workflows
- **Monitoring**: Real-time cache statistics and source validation
- **Scalability**: Support for dynamic source management without server restarts

### Key Features

- Full CRUD operations for source configurations
- Support for all existing handler types (filesystem, url, ifinder)
- Integration with app configuration workflow
- Real-time validation and testing capabilities
- Cache management and monitoring dashboard

## Technical Architecture Overview

### Current State Analysis

The existing sources system has these characteristics:

- **Source Manager**: Centralized orchestrator (`SourceManager.js`) with pluggable handlers
- **Handler Types**: filesystem, url, ifinder with extensible architecture
- **Configuration**: JSON-based app-level sources array
- **Caching**: Built-in TTL-based caching with memory storage
- **Validation**: Handler-specific configuration validation

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Admin Interface                        │
├─────────────────────────────────────────────────────────────┤
│  Sources List Page  │  Source Edit Page │  Cache Dashboard  │
├─────────────────────────────────────────────────────────────┤
│                     REST API Layer                         │
├─────────────────────────────────────────────────────────────┤
│  Source Config Service │ Validation Layer │ Cache Manager   │
├─────────────────────────────────────────────────────────────┤
│                   Source Manager                           │
├─────────────────────────────────────────────────────────────┤
│  FileSystem Handler │  URL Handler   │  iFinder Handler    │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Backend Infrastructure (Week 1-2)

#### 1.1 Source Configuration API Routes

**File**: `/server/routes/admin/sources.js`

```javascript
// Core CRUD endpoints
GET    /admin/sources              // List all sources
POST   /admin/sources              // Create new source
GET    /admin/sources/:id          // Get source details
PUT    /admin/sources/:id          // Update source
DELETE /admin/sources/:id          // Delete source

// Management endpoints
POST   /admin/sources/:id/test     // Test source configuration
POST   /admin/sources/:id/cache/clear // Clear source cache
GET    /admin/sources/cache/stats  // Get cache statistics
GET    /admin/sources/handlers     // Get available handler types
```

#### 1.2 Source Configuration Service

**File**: `/server/services/SourceConfigService.js`

```javascript
class SourceConfigService {
  // CRUD operations for source configurations
  async createSource(sourceConfig)
  async updateSource(id, sourceConfig)
  async deleteSource(id)
  async getSource(id)
  async listSources(filters = {})

  // Validation and testing
  async validateSourceConfig(sourceConfig)
  async testSourceConnection(sourceConfig)

  // Cache management
  async clearSourceCache(id)
  async getCacheStatistics()

  // App integration
  async getSourcesForApp(appId)
  async updateAppSources(appId, sourceIds)
}
```

#### 1.3 Enhanced SourceManager Integration

**Updates to**: `/server/sources/SourceManager.js`

- Add source registry for standalone source configurations
- Support for source ID-based lookups
- Enhanced cache management with per-source statistics

#### 1.4 Validation Schema

**File**: `/server/validators/sourceConfigSchema.js`

```javascript
const sourceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.object({}).optional(), // Localized names
  description: z.object({}).optional(),
  type: z.enum(['filesystem', 'url', 'ifinder']),
  config: z.object({}).refine(validateHandlerConfig),
  exposeAs: z.enum(['prompt', 'tool']).default('prompt'),
  caching: z
    .object({
      ttl: z.number().min(0).default(3600),
      strategy: z.enum(['static', 'dynamic']).default('static')
    })
    .optional(),
  enabled: z.boolean().default(true)
});
```

### Phase 2: Frontend Interface (Week 2-3)

#### 2.1 Navigation Integration

**Update**: `/client/src/features/admin/components/AdminNavigation.jsx`

Add sources navigation item:

```javascript
{
  key: 'sources',
  name: t('admin.nav.sources', 'Sources'),
  href: '/admin/sources',
  current: location.pathname.startsWith('/admin/sources')
}
```

#### 2.2 Sources List Page

**File**: `/client/src/features/admin/pages/AdminSourcesPage.jsx`

Features:

- Table view with search/filter capabilities
- Source type indicators and status badges
- Quick actions (enable/disable, test, cache clear)
- Cache statistics dashboard
- Create source button

#### 2.3 Source Edit/Create Page

**File**: `/client/src/features/admin/pages/AdminSourceEditPage.jsx`

Features:

- Dynamic form based on handler type
- Real-time validation feedback
- Configuration testing capability
- Localization support for names/descriptions
- Cache configuration options

#### 2.4 Source Configuration Components

**Files**:

- `/client/src/features/admin/components/SourceConfigForm.jsx`
- `/client/src/features/admin/components/HandlerConfigEditor.jsx`
- `/client/src/features/admin/components/SourceTestPanel.jsx`

### Phase 3: App Integration (Week 3-4)

#### 3.1 Enhanced App Editor

**Update**: `/client/src/features/admin/pages/AdminAppEditPage.jsx`

Add sources management section:

- Source selection interface
- Inline source creation option
- Source order/priority configuration
- Preview of source content in system prompt

#### 3.2 Source Selector Component

**File**: `/client/src/features/admin/components/SourceSelector.jsx`

Features:

- Multi-select source assignment
- Source creation modal
- Live preview of selected sources
- Drag-and-drop reordering

### Phase 4: Advanced Features (Week 4-5)

#### 4.1 Cache Management Dashboard

**File**: `/client/src/features/admin/pages/AdminSourcesCachePage.jsx`

Features:

- Real-time cache statistics
- Cache hit/miss metrics
- Memory usage monitoring
- Bulk cache operations

#### 4.2 Source Testing & Monitoring

**File**: `/client/src/features/admin/components/SourceMonitoring.jsx`

Features:

- Connection status monitoring
- Content preview capabilities
- Error logging and alerts
- Performance metrics

## Database/Storage Considerations

### Storage Strategy

Since AI Hub Apps uses file-based configuration, sources will be stored in:

- **Global Sources**: `/contents/config/sources.json`
- **App Sources**: Maintained in app configurations as references to global sources

### Data Structure

```json
{
  "sources": {
    "global-faq": {
      "id": "global-faq",
      "name": {
        "en": "Global FAQ Content",
        "de": "Globale FAQ Inhalte"
      },
      "description": {
        "en": "Company-wide frequently asked questions",
        "de": "Unternehmensweite häufig gestellte Fragen"
      },
      "type": "filesystem",
      "config": {
        "path": "sources/global-faq.md",
        "encoding": "utf8"
      },
      "exposeAs": "prompt",
      "caching": {
        "ttl": 3600,
        "strategy": "static"
      },
      "enabled": true,
      "createdAt": "2025-08-02T10:00:00Z",
      "updatedAt": "2025-08-02T10:00:00Z"
    }
  }
}
```

### Migration Strategy

1. **Phase 1**: Read-only global sources registry
2. **Phase 2**: Hybrid mode (both global and app-level sources)
3. **Phase 3**: Migration tool to move app sources to global registry
4. **Phase 4**: App sources as references only

## Integration Points

### 4.1 Configuration Cache Integration

**Update**: `/server/configCache.js`

Add sources configuration to cache management:

```javascript
// Enhanced cache structure
const cache = {
  // ... existing cache items
  sources: null,
  sourcesLastModified: 0
};

// Add sources reloading
async function reloadSources() {
  const sourcesConfig = await loadSourcesConfiguration();
  cache.sources = sourcesConfig;
  cache.sourcesLastModified = Date.now();
}
```

### 4.2 Authorization Integration

**Update**: `/server/utils/authorization.js`

Add source management permissions:

```javascript
const sourcePermissions = {
  'sources.read': 'View source configurations',
  'sources.write': 'Create/edit source configurations',
  'sources.delete': 'Delete source configurations',
  'sources.test': 'Test source connections',
  'sources.cache': 'Manage source cache'
};
```

### 4.3 Chat Service Integration

**Update**: `/server/services/chat/ChatService.js`

Support both app-level and global sources:

```javascript
async function loadAppSources(appConfig, context) {
  const sources = [];

  // Load app-specific sources (legacy)
  if (appConfig.sources) {
    sources.push(...appConfig.sources);
  }

  // Load global source references
  if (appConfig.globalSources) {
    const globalSources = await getGlobalSources(appConfig.globalSources);
    sources.push(...globalSources);
  }

  return await sourceManager.loadSources(sources, context);
}
```

## API Specifications

### Source Configuration Endpoints

#### GET /admin/sources

List all source configurations

**Query Parameters:**

- `type`: Filter by handler type
- `enabled`: Filter by enabled status
- `search`: Search in name/description

**Response:**

```json
{
  "sources": [
    {
      "id": "global-faq",
      "name": { "en": "Global FAQ Content" },
      "type": "filesystem",
      "enabled": true,
      "cacheStats": {
        "hitRate": 0.95,
        "lastUpdated": "2025-08-02T10:00:00Z"
      }
    }
  ],
  "totalCount": 10,
  "enabledCount": 8
}
```

#### POST /admin/sources

Create new source configuration

**Request Body:**

```json
{
  "id": "new-source",
  "name": {
    "en": "New Source",
    "de": "Neue Quelle"
  },
  "type": "filesystem",
  "config": {
    "path": "sources/new-content.md",
    "encoding": "utf8"
  },
  "exposeAs": "prompt",
  "caching": {
    "ttl": 3600,
    "strategy": "static"
  }
}
```

#### POST /admin/sources/:id/test

Test source configuration

**Response:**

```json
{
  "success": true,
  "content": "Sample content loaded successfully...",
  "metadata": {
    "contentLength": 1024,
    "loadTime": 45,
    "cacheHit": false
  },
  "errors": []
}
```

## Testing Requirements

### 5.1 Unit Tests

**Files**:

- `/server/tests/sourceConfigService.test.js`
- `/server/tests/sourceAdminRoutes.test.js`
- `/client/src/features/admin/components/__tests__/SourceConfigForm.test.jsx`

### 5.2 Integration Tests

**Files**:

- `/server/tests/sourceManagerIntegration.test.js`
- `/server/tests/appSourcesIntegration.test.js`

### 5.3 E2E Tests

**Files**:

- `/tests/e2e/adminSourcesWorkflow.spec.js`

### Test Scenarios

1. **Source CRUD Operations**
   - Create source with all handler types
   - Update source configuration
   - Delete source and verify cleanup
   - Validate error handling for invalid configs

2. **Cache Management**
   - Cache statistics accuracy
   - Cache clear functionality
   - TTL expiration behavior

3. **App Integration**
   - Source assignment to apps
   - Source content loading in chat
   - Source content in system prompts

4. **Validation & Testing**
   - Handler-specific validation
   - Source connection testing
   - Error message accuracy

## Migration/Compatibility Considerations

### 6.1 Backward Compatibility

**Legacy App Sources Support**:

- Existing app-level sources continue to work
- No breaking changes to current functionality
- Migration is opt-in and gradual

**Migration Path**:

1. **Phase 1**: Global sources as supplements to app sources
2. **Phase 2**: Migration tool to convert app sources to global
3. **Phase 3**: Deprecation warnings for app-level sources
4. **Phase 4**: Optional cleanup of legacy app sources

### 6.2 Migration Tool

**File**: `/server/utils/sourceMigration.js`

```javascript
class SourceMigration {
  // Analyze current app sources
  async analyzeAppSources()

  // Convert app sources to global sources
  async migrateAppSources(appId, options = {})

  // Generate migration report
  async generateMigrationReport()

  // Cleanup legacy sources
  async cleanupLegacySources(dryRun = true)
}
```

### 6.3 Configuration Validation

**Enhanced Validation**:

- Validate source ID uniqueness
- Check for circular dependencies
- Validate file paths for filesystem sources
- URL accessibility checks for URL sources

## Security Considerations

### 7.1 Authorization

- Source management requires admin permissions
- Per-operation permission checking (read/write/delete)
- Source content access follows existing app permissions

### 7.2 Input Validation

- Strict validation of source configurations
- Path traversal prevention for filesystem sources
- URL validation and allowlist support
- Content size limits and timeout handling

### 7.3 Audit Logging

- Log all source configuration changes
- Track source access patterns
- Monitor cache performance and errors

## Performance Optimizations

### 8.1 Caching Strategy

- In-memory cache for frequently accessed sources
- Configurable TTL per source type
- Cache warming for critical sources
- Cache statistics and monitoring

### 8.2 Lazy Loading

- Load source configurations on demand
- Pagination for large source lists
- Progressive source content loading

### 8.3 Validation Optimization

- Cache validation results
- Async validation for non-critical checks
- Bulk validation for multiple sources

## Success Metrics and KPIs

### 8.1 Operational Metrics

- **Configuration Time Reduction**: Target 80% reduction in manual configuration time
- **Error Rate**: Target <5% configuration errors
- **User Adoption**: Target 90% of source configurations through admin UI

### 8.2 Performance Metrics

- **Cache Hit Rate**: Target >90% for frequently accessed sources
- **Load Time**: Target <100ms for cached content
- **Memory Usage**: Monitor cache memory consumption

### 8.3 User Experience Metrics

- **Time to Configure**: Target <5 minutes for typical source setup
- **Support Tickets**: Target 50% reduction in configuration-related tickets

## Implementation Timeline

### Week 1: Backend Foundation

- [ ] Source configuration API routes
- [ ] Source configuration service
- [ ] Enhanced SourceManager integration
- [ ] Validation schema implementation

### Week 2: Admin Interface Core

- [ ] Sources list page
- [ ] Source edit/create page
- [ ] Basic CRUD operations
- [ ] Navigation integration

### Week 3: App Integration

- [ ] Enhanced app editor with sources
- [ ] Source selector component
- [ ] App-source relationship management
- [ ] Migration utilities

### Week 4: Advanced Features

- [ ] Cache management dashboard
- [ ] Source testing capabilities
- [ ] Monitoring and analytics
- [ ] Performance optimizations

### Week 5: Testing & Documentation

- [ ] Comprehensive testing suite
- [ ] E2E workflow tests
- [ ] Documentation updates
- [ ] Migration guides

## Risk Mitigation

### Technical Risks

- **Cache Memory Usage**: Implement cache size limits and LRU eviction
- **Source Connectivity**: Add timeout handling and retry logic
- **Configuration Conflicts**: Implement conflict detection and resolution

### Operational Risks

- **Migration Complexity**: Provide rollback capabilities and migration validation
- **Performance Impact**: Monitor cache performance and implement circuit breakers
- **User Experience**: Extensive testing and gradual feature rollout

### Mitigation Strategies

- Feature flags for gradual rollout
- Comprehensive monitoring and alerting
- Backup and restore capabilities
- User training and documentation

This implementation plan provides a comprehensive roadmap for adding sources configuration to the admin interface while maintaining backward compatibility and ensuring a smooth migration path for existing installations.
