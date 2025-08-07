# Technical Documentation

## iHub Apps Platform

### Overview

iHub Apps is a comprehensive platform for creating and managing AI-powered applications. It provides a flexible architecture that supports multiple LLM providers, authentication systems, and knowledge sources.

### Key Features

#### Multi-Source Knowledge System

The platform now supports multiple knowledge sources through a sophisticated handler system:

- **Filesystem Sources**: Load content from local files (Markdown, text, etc.)
- **URL Sources**: Fetch and process web content automatically
- **iFinder Integration**: Access enterprise document management systems
- **Caching**: Intelligent caching with configurable TTL and strategies

#### Source Configuration

Sources can be configured in app definitions with the following structure:

```json
{
  "sources": [
    {
      "id": "unique-source-id",
      "type": "filesystem|url|ifinder",
      "description": "Human readable description",
      "config": {
        // Handler-specific configuration
      },
      "exposeAs": "prompt|tool",
      "caching": {
        "ttl": 3600,
        "strategy": "static"
      },
      "enabled": true
    }
  ]
}
```

#### Source Exposure Options

Sources can be exposed in two ways:

1. **Prompt Integration** (`exposeAs: "prompt"`): Content is loaded and included in the system prompt using the `{{sources}}` template variable
2. **Tool Access** (`exposeAs: "tool"`): Content is made available as a tool that the AI can call dynamically

### Architecture Components

#### Source Handlers

- `SourceHandler`: Base class with caching and validation
- `FileSystemHandler`: Secure file system access with path validation
- `URLHandler`: Web content extraction with cleaning and metadata
- `IFinderHandler`: Enterprise document search and retrieval
- `SourceManager`: Orchestration and tool generation

#### Authentication System

- **Multi-mode**: Anonymous, Local, OIDC, Proxy authentication
- **Group-based permissions**: Hierarchical group inheritance
- **Resource filtering**: Permissions-based access control

#### LLM Integration

- **Provider Support**: OpenAI, Anthropic, Google, Mistral
- **Streaming**: Real-time response streaming
- **Tool Calling**: Dynamic function execution
- **Token Management**: Configurable limits and optimization

### Configuration Files

#### Core Configuration

- `platform.json`: Server behavior and authentication
- `apps.json`: Application definitions and settings
- `models.json`: LLM provider configurations
- `groups.json`: User permissions and hierarchy
- `ui.json`: Interface customization

#### Content Organization

- `contents/apps/`: Application definitions
- `contents/sources/`: Knowledge source files
- `contents/pages/`: Dynamic React/Markdown pages
- `contents/styles/`: Response styling templates

### Development Patterns

#### Adding New Source Handlers

1. Extend `SourceHandler` base class
2. Implement `loadContent()` method
3. Add validation logic
4. Register with `SourceManager`
5. Update configuration schema

#### Creating Applications

1. Define app configuration in JSON
2. Configure source handlers as needed
3. Set up authentication requirements
4. Test with different user contexts

### Security Considerations

#### Source Access

- Path traversal protection for filesystem sources
- URL validation and content sanitization
- User-context aware iFinder permissions
- Configurable caching policies

#### Authentication

- JWT token validation
- Group-based resource access
- Session management
- API key protection

### Performance Optimization

#### Caching Strategy

- Multi-level caching system
- Configurable TTL per source
- User-context aware cache keys
- Memory usage monitoring

#### Scaling

- Multi-worker clustering support
- Request throttling and rate limiting
- Efficient resource loading
- Streaming response optimization

This documentation covers the core platform capabilities. For specific implementation details, refer to the source code and configuration examples.
