# Configuration Validation System

This document provides comprehensive documentation for the Zod schema validation system implemented in iHub Apps. The validation system ensures configuration integrity, provides helpful error messages, and prevents runtime errors caused by malformed configurations.

## Overview

The configuration validation system uses [Zod](https://github.com/colinhacks/zod) schemas to validate all configuration files and API requests. This provides:

- **Type Safety**: Ensures configuration values match expected types and formats
- **Runtime Validation**: Catches configuration errors before they cause system failures  
- **Detailed Error Messages**: Provides clear, actionable feedback for invalid configurations
- **API Request Validation**: Validates incoming API requests to prevent malformed data
- **Development Support**: Helps developers understand expected configuration structure

## Architecture

### Components

1. **Schema Definitions** (`/server/validators/`): Individual schema files for each configuration type
2. **Validation Middleware** (`/server/validators/validate.js`): Express middleware for API request validation
3. **Configuration Loaders** (`/server/*Loader.js`): Apply validation during configuration loading
4. **Resource Loader Factory** (`/server/utils/resourceLoader.js`): Generic validation framework

### Validation Flow

```
Configuration File → Schema Validation → Error Logging → Application Loading
                                    ↓
API Request → Middleware Validation → Error Response / Continue
```

## Available Schemas

### 1. Application Configuration (`appConfigSchema.js`)

Validates AI application definitions including prompts, variables, and settings.

**Key Components:**
- **Localized Strings**: Multi-language support with locale validation
- **Variables**: User input fields with type validation
- **Settings**: UI and feature configuration
- **Upload Configuration**: File and image upload settings
- **Inheritance**: Parent-child app relationships

**Example Valid Configuration:**
```json
{
  "id": "chat-assistant",
  "name": {
    "en": "Chat Assistant",
    "de": "Chat-Assistent"
  },
  "description": {
    "en": "General purpose AI assistant",
    "de": "Allzweck-KI-Assistent"
  },
  "color": "#4F46E5",
  "icon": "chat-bubble",
  "system": {
    "en": "You are a helpful AI assistant."
  },
  "tokenLimit": 4000,
  "variables": [
    {
      "name": "context",
      "label": {
        "en": "Context"
      },
      "type": "text",
      "required": false
    }
  ]
}
```

### 2. Model Configuration (`modelConfigSchema.js`)

Validates LLM model definitions and connection parameters.

**Key Components:**
- **Provider Types**: openai, anthropic, google, mistral, local
- **Token Limits**: Min 1, max 1,000,000
- **Concurrency Controls**: Rate limiting configuration
- **Thinking Support**: O1-style reasoning configuration

**Example Valid Configuration:**
```json
{
  "id": "gpt-4o",
  "modelId": "gpt-4o-2024-08-06",
  "name": {
    "en": "GPT-4o",
    "de": "GPT-4o"
  },
  "description": {
    "en": "Latest GPT-4 model optimized for chat"
  },
  "url": "https://api.openai.com/v1/chat/completions",
  "provider": "openai",
  "tokenLimit": 128000,
  "supportsTools": true,
  "enabled": true
}
```

### 3. Source Configuration (`sourceConfigSchema.js`)

Validates data source configurations with type-specific validation.

**Source Types:**
- **filesystem**: Local file access
- **url**: HTTP/HTTPS endpoints  
- **ifinder**: iFinder search integration
- **page**: Internal page references

**Example Valid Configuration:**
```json
{
  "id": "documentation",
  "name": {
    "en": "Documentation"
  },
  "type": "url",
  "config": {
    "url": "https://docs.example.com/api",
    "method": "GET",
    "timeout": 10000,
    "followRedirects": true,
    "cleanContent": true
  },
  "enabled": true,
  "exposeAs": "prompt"
}
```

### 4. Platform Configuration (`platformConfigSchema.js`)

Validates core platform settings including authentication and authorization.

**Key Components:**
- **Authentication Modes**: proxy, local, oidc, anonymous
- **OIDC Providers**: OAuth2/OpenID Connect configuration
- **JWT Validation**: Token verification settings
- **Debug Settings**: Authentication debugging options

### 5. Group Configuration (`groupConfigSchema.js`)

Validates user group definitions with inheritance support.

**Key Components:**
- **Permissions**: Resource access control arrays
- **Inheritance**: Group hierarchy with circular dependency detection
- **External Mappings**: Integration with external auth providers

### 6. User Configuration (`userConfigSchema.js`)

Validates user account definitions for local authentication.

**Key Components:**
- **Identity**: Username, email, full name validation
- **Authentication**: Password handling for local auth
- **External Integration**: Provider mapping for SSO users

### 7. Prompt Configuration (`promptConfigSchema.js`)

Validates standalone prompt definitions.

**Key Components:**
- **Variables**: Input parameter definitions
- **Actions**: Available prompt actions
- **Output Schema**: Structured response configuration

## Error Handling

### Validation Error Types

1. **Schema Validation Errors**: Type mismatches, missing required fields
2. **Format Validation Errors**: Invalid formats (URLs, hex colors, regex patterns)
3. **Business Logic Errors**: Custom validation rules (path traversal, circular inheritance)
4. **Unknown Key Warnings**: Properties not defined in schema

### Error Message Format

**API Request Errors (HTTP 400):**
```json
{
  "error": "Invalid request",
  "details": [
    {
      "code": "invalid_type",
      "expected": "string",
      "received": "number",
      "path": ["name", "en"],
      "message": "Expected string, received number"
    }
  ]
}
```

**Configuration Loading Warnings:**
```
⚠️  Validation issues in /contents/apps/invalid-app.json: 
   name.en: String must contain at least 1 character(s); 
   color: Color must be a valid hex code (e.g., #4F46E5)
```

### Error Recovery

- **Configuration Errors**: Invalid configurations are logged but don't prevent application startup
- **API Errors**: Requests with validation errors are rejected with detailed error responses
- **Graceful Degradation**: System continues operating with valid configurations only

## API Request Validation

### Validation Middleware

The `validate()` middleware function validates incoming API requests:

```javascript
import validate from './validators/validate.js';
import { chatPostSchema } from './validators/index.js';

app.post('/api/chat', validate(chatPostSchema), (req, res) => {
  // req.body is guaranteed to be valid here
});
```

### Available Request Schemas

- **chatPostSchema**: Chat message submissions
- **chatTestSchema**: Model connectivity tests
- **feedbackSchema**: User feedback submissions
- **runToolSchema**: Tool execution requests
- **magicPromptSchema**: Prompt enhancement requests

## Extending Schemas

### Adding New Fields

1. **Define the field in the schema:**
```javascript
export const appConfigSchema = z.object({
  // existing fields...
  newFeature: z.boolean().optional().default(false),
});
```

2. **Update known keys array:**
```javascript
export const knownAppKeys = Object.keys(appConfigSchema.shape);
```

3. **Add field to TypeScript types if used:**
```typescript
interface AppConfig {
  newFeature?: boolean;
  // other fields...
}
```

### Creating New Schemas

1. **Create schema file** (`/server/validators/newConfigSchema.js`):
```javascript
import { z } from 'zod';

export const newConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true)
}).strict();

export const knownNewConfigKeys = Object.keys(newConfigSchema.shape);
```

2. **Integrate with resource loader:**
```javascript
import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { newConfigSchema, knownNewConfigKeys } from './validators/newConfigSchema.js';

const newConfigLoader = createResourceLoader({
  resourceName: 'NewConfig',
  legacyPath: 'config/newconfigs.json',
  individualPath: 'newconfigs',
  validateItem: createSchemaValidator(newConfigSchema, knownNewConfigKeys)
});
```

### Custom Validation Rules

Add complex validation beyond schema definitions:

```javascript
export function validateNewConfig(config) {
  try {
    const validated = newConfigSchema.parse(config);
    
    // Custom business logic validation
    if (validated.complexField && !validateComplexLogic(validated.complexField)) {
      throw new Error('Complex field validation failed');
    }
    
    return { success: true, data: validated };
  } catch (error) {
    return { 
      success: false, 
      errors: error.errors || [{ message: error.message }] 
    };
  }
}
```

## Configuration Examples

### Application Configuration

**Valid Configuration:**
```json
{
  "id": "data-analyzer",
  "name": {
    "en": "Data Analyzer",
    "de": "Datenanalysator"
  },
  "description": {
    "en": "Analyze and visualize data"
  },
  "color": "#059669",
  "icon": "chart-bar",
  "system": {
    "en": "You are a data analysis expert."
  },
  "tokenLimit": 8000,
  "variables": [
    {
      "name": "dataType",
      "label": {
        "en": "Data Type"
      },
      "type": "select",
      "required": true,
      "predefinedValues": [
        {
          "value": "csv",
          "label": {
            "en": "CSV File"
          }
        },
        {
          "value": "json", 
          "label": {
            "en": "JSON Data"
          }
        }
      ]
    }
  ],
  "settings": {
    "temperature": {
      "enabled": true
    },
    "outputFormat": {
      "enabled": false
    }
  },
  "upload": {
    "enabled": true,
    "fileUpload": {
      "enabled": true,
      "maxFileSizeMB": 10,
      "supportedTextFormats": [
        "text/csv",
        "application/json"
      ]
    }
  }
}
```

**Common Invalid Examples:**

```json
// ❌ Missing required fields
{
  "name": "Missing ID and other required fields"
}

// ❌ Invalid color format  
{
  "id": "test",
  "color": "blue",  // Must be hex like #4F46E5
  "name": { "en": "Test" }
}

// ❌ Invalid variable name
{
  "id": "test", 
  "variables": [
    {
      "name": "invalid-name",  // Must be alphanumeric/underscore only
      "label": { "en": "Test" },
      "type": "string"
    }
  ]
}

// ❌ Invalid token limit
{
  "id": "test",
  "tokenLimit": 2000000,  // Exceeds maximum of 1,000,000
  "name": { "en": "Test" }
}
```

### Model Configuration

**Valid Configuration:**
```json
{
  "id": "claude-3-5-sonnet",
  "modelId": "claude-3-5-sonnet-20241022", 
  "name": {
    "en": "Claude 3.5 Sonnet"
  },
  "description": {
    "en": "Most intelligent Claude model"
  },
  "url": "https://api.anthropic.com/v1/messages",
  "provider": "anthropic",
  "tokenLimit": 200000,
  "supportsTools": true,
  "concurrency": 5,
  "requestDelayMs": 1000,
  "enabled": true
}
```

**Common Invalid Examples:**

```json
// ❌ Invalid provider
{
  "id": "test-model",
  "provider": "invalid-provider",  // Must be: openai, anthropic, google, mistral, local
  "tokenLimit": 4000
}

// ❌ Invalid URL format
{
  "id": "test-model", 
  "url": "not-a-valid-url",
  "provider": "openai"
}

// ❌ Token limit out of range
{
  "id": "test-model",
  "tokenLimit": 0,  // Must be at least 1
  "provider": "openai"
}
```

## Troubleshooting

### Common Issues

1. **"Invalid language code format"**
   - **Cause**: Localized strings using invalid language codes
   - **Solution**: Use ISO 639-1 codes like "en", "de", "fr" or with region like "en-US"

2. **"Color must be a valid hex code"**
   - **Cause**: Color values not in hex format
   - **Solution**: Use 6-digit hex codes like "#4F46E5", "#059669"

3. **"Variable name must start with letter/underscore"**
   - **Cause**: Variable names with invalid characters
   - **Solution**: Use alphanumeric characters and underscores only: "userName", "data_type"

4. **"Unknown keys in configuration"**
   - **Cause**: Configuration contains properties not defined in schema
   - **Solution**: Remove unknown properties or add them to the schema

5. **"Validation issues: Expected string, received number"**
   - **Cause**: Type mismatch between expected and actual values
   - **Solution**: Ensure values match expected types (strings in quotes, numbers without)

### Debugging Validation

Enable verbose logging during development:

```javascript
// In configuration loading
const result = schema.safeParse(config);
if (!result.success) {
  console.log('Validation errors:', JSON.stringify(result.error.errors, null, 2));
}
```

Use schema testing in development:

```javascript
import { appConfigSchema } from './validators/appConfigSchema.js';

// Test configuration 
const testConfig = { /* your config */ };
const result = appConfigSchema.safeParse(testConfig);

if (result.success) {
  console.log('Valid configuration:', result.data);
} else {
  console.log('Validation errors:', result.error.errors);
}
```

### Performance Considerations

- **Schema Parsing**: Validation occurs during configuration loading, not on every request
- **Caching**: Validated configurations are cached until changed
- **Middleware**: API validation adds minimal overhead (~1ms per request)
- **Memory Usage**: Zod schemas are lightweight and reusable

## Best Practices

1. **Always validate new configuration types** with appropriate schemas
2. **Use strict schemas** (`.strict()`) to catch unexpected properties  
3. **Provide helpful error messages** with context about what's wrong
4. **Test configurations** with both valid and invalid examples
5. **Use TypeScript types** that match Zod schemas for type safety
6. **Document schema changes** when adding new fields or validation rules
7. **Consider backwards compatibility** when modifying existing schemas

## Integration with Development Workflow

### Pre-commit Validation

Add validation checks to your development workflow:

```bash
# Validate all configurations before commit
npm run validate:configs

# Or integrate with git hooks
git add .
git commit -m "Update configuration"  # Will validate before committing
```

### Configuration Testing

```javascript
// Test configuration files
import { validateAppConfig } from './validators/appConfigSchema.js';

describe('App Configuration', () => {
  test('should validate correct configuration', () => {
    const config = { /* valid config */ };
    const result = validateAppConfig(config);
    expect(result.success).toBe(true);
  });

  test('should reject invalid configuration', () => {
    const config = { /* invalid config */ };
    const result = validateAppConfig(config);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });
});
```

This validation system ensures configuration integrity while providing clear feedback for developers and administrators managing the iHub Apps platform.