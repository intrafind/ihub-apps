# Plugin-Based Integration Architecture Draft

## Overview

This document outlines the proposed plugin-based architecture for AI Hub Apps integrations, starting with the iFinder integration and designed to easily accommodate future integrations.

## Core Architecture

### 1. Plugin System Structure

```
server/
├── plugins/
│   ├── base/
│   │   ├── IntegrationPlugin.js          # Base plugin class
│   │   ├── SourceHandler.js              # Base source handler
│   │   └── ToolHandler.js                # Base tool handler
│   ├── ifinder/
│   │   ├── iFinderPlugin.js              # Main plugin class
│   │   ├── handlers/
│   │   │   ├── iFinderSourceHandler.js   # Search functionality
│   │   │   └── iFinderToolHandler.js     # Tool registration
│   │   ├── services/
│   │   │   ├── iFinderService.js         # API client
│   │   │   └── iFinderAuth.js            # Authentication
│   │   └── config/
│   │       └── schema.js                 # Configuration validation
│   └── sharepoint/                       # Future plugin example
│       ├── sharepointPlugin.js
│       └── handlers/
└── core/
    ├── IntegrationManager.js             # Plugin orchestration
    └── PluginRegistry.js                 # Plugin discovery & loading
```

### 2. Base Plugin Interface

```javascript
// server/plugins/base/IntegrationPlugin.js
export class IntegrationPlugin {
  constructor(config, instanceId) {
    this.config = config;
    this.instanceId = instanceId;
    this.type = this.constructor.name.replace('Plugin', '').toLowerCase();
    this.status = 'inactive';
  }

  // Required methods to implement
  async initialize() { throw new Error('Must implement initialize()'); }
  async healthCheck() { throw new Error('Must implement healthCheck()'); }
  async getCapabilities() { throw new Error('Must implement getCapabilities()'); }
  
  // Optional lifecycle methods
  async start() { this.status = 'active'; }
  async stop() { this.status = 'inactive'; }
  async configure(newConfig) { this.config = { ...this.config, ...newConfig }; }

  // Plugin metadata
  getMetadata() {
    return {
      type: this.type,
      instanceId: this.instanceId,
      status: this.status,
      version: this.version,
      capabilities: this.capabilities
    };
  }
}
```

### 3. Integration Manager

```javascript
// server/core/IntegrationManager.js
export class IntegrationManager {
  constructor() {
    this.plugins = new Map();
    this.registry = new PluginRegistry();
  }

  async loadPlugins() {
    const pluginConfigs = await this.loadIntegrationConfigs();
    
    for (const [instanceId, config] of Object.entries(pluginConfigs)) {
      const plugin = await this.registry.createPlugin(config.type, config, instanceId);
      await plugin.initialize();
      this.plugins.set(instanceId, plugin);
    }
  }

  getPlugin(instanceId) {
    return this.plugins.get(instanceId);
  }

  getActivePlugins(type = null) {
    return Array.from(this.plugins.values())
      .filter(plugin => 
        plugin.status === 'active' && 
        (type ? plugin.type === type : true)
      );
  }

  async executeSource(instanceId, sourceType, params) {
    const plugin = this.getPlugin(instanceId);
    if (!plugin) throw new Error(`Plugin ${instanceId} not found`);
    
    return await plugin.executeSource(sourceType, params);
  }
}
```

## Configuration Schema

### 1. Integrations Configuration File

```json
// contents/config/integrations.json
{
  "integrations": {
    "ifinder-main": {
      "type": "ifinder",
      "enabled": true,
      "name": "iFinder Main Instance",
      "description": "Primary iFinder integration for document search",
      "config": {
        "baseUrl": "${IFINDER_BASE_URL}",
        "authentication": {
          "type": "jwt",
          "jwtSecret": "${IFINDER_JWT_SECRET}",
          "user": "${IFINDER_USER}",
          "tenant": "${IFINDER_TENANT}"
        },
        "search": {
          "maxResults": 10,
          "timeout": 30000,
          "defaultQuery": "*"
        }
      },
      "capabilities": ["search", "tools"],
      "permissions": {
        "groups": ["users", "admin"],
        "apps": ["*"]
      }
    },
    "ifinder-technical": {
      "type": "ifinder",
      "enabled": true,
      "name": "iFinder Technical Docs",
      "description": "Technical documentation search",
      "config": {
        "baseUrl": "${IFINDER_TECH_BASE_URL}",
        "authentication": {
          "type": "jwt",
          "jwtSecret": "${IFINDER_TECH_JWT_SECRET}",
          "user": "${IFINDER_TECH_USER}",
          "tenant": "technical-docs"
        },
        "search": {
          "maxResults": 5,
          "filterByTenant": true
        }
      },
      "capabilities": ["search"],
      "permissions": {
        "groups": ["developers", "admin"],
        "apps": ["code-helper", "documentation-assistant"]
      }
    }
  }
}
```

### 2. App Configuration Enhancement

```json
// Enhanced apps.json with integration support
{
  "legal-assistant": {
    "id": "legal-assistant",
    "name": {"en": "Legal Assistant"},
    "integrations": {
      "ifinder-main": {
        "sources": ["search"],
        "tools": ["ifinder_search"],
        "priority": 1
      }
    },
    "sources": [
      {
        "id": "legal-docs",
        "integration": "ifinder-main",
        "type": "search",
        "config": {
          "query": "category:legal",
          "maxResults": 5
        }
      }
    ]
  }
}
```

## Implementation Examples

### 1. iFinder Plugin Implementation

```javascript
// server/plugins/ifinder/iFinderPlugin.js
import { IntegrationPlugin } from '../base/IntegrationPlugin.js';
import { iFinderSourceHandler } from './handlers/iFinderSourceHandler.js';
import { iFinderToolHandler } from './handlers/iFinderToolHandler.js';

export class iFinderPlugin extends IntegrationPlugin {
  constructor(config, instanceId) {
    super(config, instanceId);
    this.version = '1.0.0';
    this.capabilities = ['search', 'tools'];
    
    this.sourceHandler = new iFinderSourceHandler(this);
    this.toolHandler = new iFinderToolHandler(this);
  }

  async initialize() {
    // Validate configuration
    await this.validateConfig();
    
    // Test connection
    await this.healthCheck();
    
    // Register tools
    await this.toolHandler.registerTools();
    
    this.status = 'initialized';
  }

  async healthCheck() {
    try {
      const response = await this.sourceHandler.testConnection();
      return { status: 'healthy', response };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }

  async executeSource(sourceType, params) {
    switch (sourceType) {
      case 'search':
        return await this.sourceHandler.search(params);
      default:
        throw new Error(`Unknown source type: ${sourceType}`);
    }
  }

  getCapabilities() {
    return {
      sources: ['search'],
      tools: ['ifinder_search'],
      authentication: ['jwt'],
      features: ['multi-tenant', 'filtering', 'ranking']
    };
  }
}
```

### 2. Source Handler Example

```javascript
// server/plugins/ifinder/handlers/iFinderSourceHandler.js
import { SourceHandler } from '../../base/SourceHandler.js';

export class iFinderSourceHandler extends SourceHandler {
  constructor(plugin) {
    super(plugin);
    this.service = new iFinderService(plugin.config);
  }

  async search(params) {
    const {
      query = '*',
      maxResults = this.plugin.config.search.maxResults,
      filters = {}
    } = params;

    try {
      const results = await this.service.search({
        query,
        count: maxResults,
        ...filters
      });

      return {
        success: true,
        results: results.elements?.map(this.transformResult) || [],
        totalResults: results.totalHits,
        integration: this.plugin.instanceId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        integration: this.plugin.instanceId
      };
    }
  }

  transformResult(element) {
    return {
      id: element.identifier,
      title: element.title,
      content: element.body,
      url: element.url,
      source: 'ifinder',
      metadata: {
        tenant: element.tenant,
        contentType: element.contentType,
        lastModified: element.lastModified
      }
    };
  }
}
```

## Admin Interface Design

### 1. Integration Management UI

```javascript
// Proposed admin interface structure
const integrationAdminFeatures = {
  // Integration listing and status
  list: {
    view: 'table',
    columns: ['name', 'type', 'status', 'instances', 'actions'],
    filters: ['type', 'status', 'enabled'],
    actions: ['enable', 'disable', 'configure', 'test', 'delete']
  },

  // Integration configuration form
  configuration: {
    formType: 'dynamic', // Generated from plugin schema
    validation: 'real-time',
    testing: 'inline',
    preview: 'live'
  },

  // Integration monitoring
  monitoring: {
    healthChecks: 'automatic',
    metrics: ['requests', 'errors', 'response_times'],
    alerts: 'configurable'
  }
};
```

### 2. Dynamic Form Generation

```javascript
// Admin form configuration based on plugin schema
const iFinderFormSchema = {
  sections: [
    {
      title: 'Connection Settings',
      fields: [
        {
          name: 'baseUrl',
          type: 'url',
          label: 'iFinder Base URL',
          required: true,
          validation: 'url',
          help: 'The base URL of your iFinder instance'
        },
        {
          name: 'authentication.jwtSecret',
          type: 'password',
          label: 'JWT Secret',
          required: true,
          sensitive: true
        }
      ]
    },
    {
      title: 'Search Configuration',
      fields: [
        {
          name: 'search.maxResults',
          type: 'number',
          label: 'Max Results',
          default: 10,
          min: 1,
          max: 100
        }
      ]
    }
  ],
  actions: [
    { name: 'test', label: 'Test Connection', type: 'validate' },
    { name: 'save', label: 'Save Configuration', type: 'submit' }
  ]
};
```

## Migration Strategy

### Phase 1: Foundation (Week 1-2)
1. Create base plugin architecture
2. Implement IntegrationManager and PluginRegistry
3. Create configuration schema and validation

### Phase 2: iFinder Migration (Week 2-3)
1. Convert existing iFinder integration to plugin
2. Maintain backward compatibility
3. Test multi-instance support

### Phase 3: Admin Interface (Week 3-4)
1. Build integration management UI
2. Implement dynamic configuration forms
3. Add monitoring and testing capabilities

### Phase 4: Documentation and Extension (Week 4-5)
1. Create plugin development documentation
2. Build example plugins (SharePoint, Confluence)
3. Performance optimization and testing

## Benefits of This Architecture

### Developer Benefits
- **Standardized Interface**: Consistent patterns for all integrations
- **Hot Reloading**: Configuration changes without server restart
- **Testing Framework**: Built-in testing and validation
- **Documentation**: Auto-generated API docs from schemas

### Business Benefits
- **Multi-Instance**: Support multiple configurations per integration type
- **Enterprise Ready**: Proper permission and tenant isolation
- **Scalable**: Easy to add new integration types
- **Maintainable**: Clear separation of concerns

### User Benefits
- **Admin Control**: Full integration management through UI
- **Flexibility**: Per-app integration configuration
- **Reliability**: Health monitoring and error handling
- **Performance**: Optimized plugin loading and caching

## Next Steps

1. Review and approve this architectural approach
2. Begin implementation with Phase 1 foundation
3. Plan detailed implementation timeline
4. Define success metrics and testing strategy

This plugin-based architecture will transform AI Hub Apps into a truly extensible platform while maintaining the robust functionality of the current iFinder integration.