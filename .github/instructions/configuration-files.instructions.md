---
applyTo: "contents/**/*.json"
---

# Configuration File Guidelines for iHub Apps

When working with JSON configuration files, follow these specific guidelines:

## General Rules

1. **Valid JSON** - Ensure all JSON files are properly formatted and valid
2. **Schema Validation** - Configuration is validated using Zod schemas in `server/validators/`
3. **No Comments** - JSON doesn't support comments; use documentation files instead
4. **Consistent Formatting** - Use 2-space indentation (matching Prettier config)

## App Configuration (`contents/apps/*.json`)

Each app is defined in its own JSON file (not in an array).

### Required Fields

```json
{
  "id": "unique-app-id",           // Max 50 chars, kebab-case
  "name": {                         // Localized app names
    "en": "App Name",
    "de": "App-Name"
  },
  "description": {                  // Localized descriptions
    "en": "Description",
    "de": "Beschreibung"
  },
  "color": "#4F46E5",              // Hex color code
  "icon": "ChatBubbleLeftRightIcon", // Icon identifier
  "system": {                       // Localized system prompts
    "en": "You are a helpful assistant...",
    "de": "Du bist ein hilfreicher Assistent..."
  },
  "tokenLimit": 4096               // Max tokens (1-1,000,000)
}
```

### Optional Fields (Common)

- `order` - Display order (number)
- `preferredModel` - Default model selection
- `preferredOutputFormat` - "markdown", "text", "json", or "html"
- `sendChatHistory` - Include chat history (boolean, default: true)
- `variables` - Array of input variable definitions
- `tools` - Array of available tool names
- `allowedModels` - Restricted model list (array of model IDs)
- `enabled` - Enable/disable app (boolean, default: true)

### Internationalization

All user-facing fields must have English (`en`) and German (`de`) translations:
- `name`, `description`, `system`, `prompt`, `messagePlaceholder`, `greeting`

## Model Configuration (`contents/models/*.json`)

Each model is defined in its own JSON file.

### Required Fields

```json
{
  "id": "model-id",                 // Unique identifier
  "modelId": "gpt-4",              // Provider's model identifier
  "name": {                         // Localized model names
    "en": "GPT-4",
    "de": "GPT-4"
  },
  "provider": "openai",            // Provider: openai, anthropic, google, mistral
  "tokenLimit": 8192,              // Maximum tokens
  "enabled": true                  // Whether model is available
}
```

### Optional Fields

- `url` - Custom endpoint URL (for local providers)
- `supportsTools` - Tool calling support (boolean)
- `supportsVision` - Image input support (boolean)
- `description` - Localized model descriptions
- `apiKeyEnvVar` - Environment variable for API key (default based on provider)

## Groups Configuration (`contents/config/groups.json`)

Defines user groups with hierarchical inheritance.

### Structure

```json
{
  "groups": {
    "admin": {
      "id": "admin",
      "name": "Admin",
      "description": "Full administrative access",
      "inherits": ["users"],        // Inherits from users group
      "permissions": {
        "apps": ["*"],              // All apps
        "prompts": ["*"],           // All prompts
        "models": ["*"],            // All models
        "adminAccess": true
      },
      "mappings": ["Admins", "IT-Admin"]  // External group names
    }
  }
}
```

### Key Features

- **Inheritance**: Use `inherits` array to inherit from parent groups
- **Permission Merging**: Child permissions merged with inherited permissions
- **Circular Prevention**: System validates for circular dependencies
- **Standard Hierarchy**: `admin` → `users` → `authenticated` → `anonymous`

## Platform Configuration (`contents/config/platform.json`)

**CRITICAL**: Changes to this file require server restart.

### Key Sections

```json
{
  "authentication": {
    "mode": "local",                // anonymous, local, oidc, proxy
    "jwt": { /* JWT settings */ },
    "oidc": { /* OIDC settings */ }
  },
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  },
  "cors": {
    "origin": ["http://localhost:3000", "${ALLOWED_ORIGINS}"],
    "credentials": true
  },
  "defaultLanguage": "en",         // Never assume English, respect this value
  "features": { /* Feature flags */ }
}
```

## UI Configuration (`contents/config/ui.json`)

Controls UI customization and branding.

```json
{
  "branding": {
    "name": { "en": "iHub Apps", "de": "iHub Apps" },
    "logo": "/logo.png",
    "favicon": "/favicon.ico"
  },
  "theme": {
    "primaryColor": "#4F46E5",
    "darkMode": true
  },
  "pages": {                        // Dynamic pages
    "home": "home",
    "about": "about"
  }
}
```

## Sources Configuration (`contents/config/sources.json`)

Knowledge source configurations.

```json
{
  "sources": [
    {
      "id": "local-docs",
      "type": "filesystem",
      "name": { "en": "Local Documentation", "de": "Lokale Dokumentation" },
      "path": "/path/to/docs",
      "enabled": true
    }
  ]
}
```

## Tools Configuration (`contents/config/tools.json`)

Available tools and their settings.

```json
{
  "tools": [
    {
      "id": "web-search",
      "name": { "en": "Web Search", "de": "Websuche" },
      "enabled": true,
      "config": { /* Tool-specific config */ }
    }
  ]
}
```

## Best Practices

### 1. Maintain Schema Compliance

Always follow the Zod schemas defined in `server/validators/`:
- `appConfigSchema.js` - App configuration schema
- `modelConfigSchema.js` - Model configuration schema
- Other validators for platform, groups, etc.

### 2. Localization

Provide translations for all user-facing text:

```json
// Good
{
  "name": {
    "en": "English Name",
    "de": "Deutscher Name"
  }
}

// Bad - missing German translation
{
  "name": {
    "en": "English Name"
  }
}
```

### 3. Environment Variables

Use environment variable placeholders for dynamic values:

```json
{
  "cors": {
    "origin": ["http://localhost:3000", "${ALLOWED_ORIGINS}"]
  }
}
```

### 4. Security

Never include API keys or secrets in configuration files:

```json
// Bad - API key in config
{
  "apiKey": "sk-abc123..."
}

// Good - Reference to environment variable
{
  "apiKeyEnvVar": "CUSTOM_API_KEY"
}
```

## Configuration Hot-Reload

**Requires Restart:**
- `contents/config/platform.json` (authentication, core settings)

**Auto-Reloads (No Restart):**
- `contents/apps/*.json` (apps)
- `contents/models/*.json` (models)
- `contents/config/ui.json` (UI settings)
- `contents/config/groups.json` (groups and permissions)
- `contents/config/sources.json` (sources)
- `contents/config/tools.json` (tools)

## Common Mistakes to Avoid

❌ **Don't:**
- Use trailing commas in JSON (invalid JSON)
- Include comments in JSON files
- Hardcode API keys or secrets
- Skip required fields
- Forget localization (en + de minimum)
- Use inconsistent field names
- Create circular group inheritance

✅ **Do:**
- Validate JSON syntax
- Follow established schemas
- Use environment variables for secrets
- Include all required fields
- Provide en + de translations
- Follow naming conventions
- Test configuration changes
- Document complex configurations in `docs/` (update existing files) or `concepts/` (for design decisions)

## Testing Configuration Changes

After modifying configuration:

1. **Validate JSON** - Ensure valid JSON syntax
2. **Test Server Startup** - Run `timeout 10s node server/server.js`
3. **Check Logs** - Look for validation errors in server logs
4. **Test Functionality** - Verify the feature works as expected
5. **Test Hot-Reload** - For auto-reload configs, verify changes apply without restart
