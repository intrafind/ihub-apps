# Platform Configuration

The optional `platform.json` file controls global platform behavior and is located under `contents/config`. This configuration supports a wide range of features including authentication, CORS settings, PDF export, global prompt variables, and more.

## Configuration Structure

```json
{
  "features": {
    "usageTracking": true
  },
  "globalPromptVariables": {
    "context": "Very important: The user's timezone is {{timezone}}. The current date is {{date}}..."
  },
  "pdfExport": {
    "defaultTemplate": "default",
    "watermark": {
      "enabled": true,
      "text": "iHub Apps",
      "position": "bottom-right",
      "opacity": 0.5
    },
    "templates": {
      "default": {
        "name": "Default",
        "description": "Standard chat export with colors and branding"
      }
    }
  },
  "defaultLanguage": "en",
  "requestBodyLimitMB": 50,
  "requestConcurrency": 5,
  "requestDelayMs": 0,
  "telemetry": {
    "enabled": false,
    "metrics": true,
    "traces": true,
    "logs": true,
    "port": 9464
  },
  "cors": {
    "origin": ["http://localhost:3000", "http://localhost:5173", "${ALLOWED_ORIGINS}"],
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
    "credentials": true
  },
  "refreshSalt": {
    "salt": 1,
    "lastUpdated": "2025-07-08T17:00:38.743Z"
  },
  "admin": {
    "pages": {
      "usage": true,
      "models": true
    }
  },
  "swagger": {
    "enabled": true,
    "requireAuth": true
  }
}
```

## Core Configuration Options

### **features**
Controls platform feature flags and capabilities.

- **usageTracking** (boolean) – Enables or disables recording of usage statistics in `contents/data/usage.json`. Default: `true`

### **globalPromptVariables**

Global prompt variables enable platform administrators to inject dynamic context and information into all AI conversations automatically. These variables are resolved at runtime and can be used in app system prompts, user prompts, and the global context string.

#### Configuration

```json
{
  "globalPromptVariables": {
    "context": "Very important: The user's timezone is {{timezone}}. The current date is {{date}}. Any dates before this are in the past, and any dates after this are in the future. When dealing with modern entities/companies/people, and the user asks for the 'latest', 'most recent', 'today's', etc. don't assume your knowledge is up to date; You can and should speak any language the user asks you to speak or use the language of the user."
  }
}
```

#### Properties

- **context** (string) – Global context string that is automatically prepended to all system prompts across the platform. This string can include dynamic variable placeholders that are resolved at runtime. The processed context is available via the `{{platform_context}}` variable in app configurations.

#### Available Built-in Variables

The platform automatically provides the following variables that can be used in the `context` string or in any app prompt:

| Variable | Description | Example Value |
|----------|-------------|---------------|
| `{{year}}` | Current year | `"2026"` |
| `{{month}}` | Current month (zero-padded) | `"01"` |
| `{{date}}` | Localized full date | `"January 19, 2026"` |
| `{{time}}` | Localized time | `"7:13:29 PM"` |
| `{{day_of_week}}` | Localized day of week | `"Sunday"` |
| `{{timezone}}` | User's timezone | `"America/New_York"` or `"UTC"` |
| `{{locale}}` | Current language/locale | `"en"`, `"de"` |
| `{{user_name}}` | Authenticated user's display name | `"John Doe"` (empty for anonymous) |
| `{{user_email}}` | Authenticated user's email | `"john@example.com"` (empty for anonymous) |
| `{{model_name}}` | Current model being used | `"gpt-4"` |
| `{{tone}}` | Selected tone/style setting | `"professional"` |
| `{{location}}` | User's location (if configured) | `"San Francisco, CA"` |
| `{{platform_context}}` | The processed global context | Full context string with variables resolved |

**Note:** All date and time variables respect the user's timezone setting. If no timezone is configured for the user, UTC is used as the default.

#### How It Works

1. **Platform Level:** The `context` string in `globalPromptVariables` is processed by replacing all variable placeholders with their actual values
2. **Variable Resolution:** Built-in variables are automatically populated from user profile, session data, and system state
3. **App Integration:** Apps can reference the processed context using `{{platform_context}}` in their system prompts
4. **Automatic Injection:** All variables are available in any prompt template without explicit declaration

#### Use Cases

**1. Date and Time Awareness**
Ensure AI responses are contextually aware of the current date and time:
```json
{
  "context": "Important: Today is {{date}} ({{day_of_week}}) at {{time}} {{timezone}}. Use this when discussing current events or time-sensitive topics."
}
```

**2. Personalization**
Provide user-specific context in all interactions:
```json
{
  "context": "You are assisting {{user_name}} ({{user_email}}) who is located in {{location}}. Tailor your responses to their context and timezone ({{timezone}})."
}
```

**3. Localization Support**
Ensure responses match the user's language preference:
```json
{
  "context": "The user's preferred language is {{locale}}. Always respond in this language unless explicitly asked otherwise. The user's timezone is {{timezone}} and the current date is {{date}}."
}
```

**4. Knowledge Cutoff Awareness**
Help AI models acknowledge their training data limitations:
```json
{
  "context": "Very important: The current date is {{date}}. Your knowledge cutoff may be before this date. When users ask for 'latest', 'recent', or 'today's' information about events, news, or data, acknowledge that your knowledge may be outdated and suggest alternative approaches if you cannot provide current information."
}
```

**5. Compliance and Auditing**
Include tracking information for enterprise requirements:
```json
{
  "context": "User: {{user_name}} ({{user_email}}), Session Time: {{date}} {{time}} {{timezone}}, Model: {{model_name}}. Ensure all responses comply with company policies."
}
```

#### Using Variables in App Configurations

Global variables can be used in any app's `system` prompt or custom prompt templates:

**Example App with Global Variables:**
```json
{
  "id": "research-assistant",
  "name": { "en": "Research Assistant" },
  "system": {
    "en": "{{platform_context}}\n\nYou are a research assistant helping {{user_name}}. Today is {{date}} at {{time}} in {{timezone}}. When providing information, always consider whether it might be outdated relative to today's date."
  },
  "prompt": {
    "en": "Research the following topic: {{topic}}\n\nRemember: Current date is {{date}}, user timezone is {{timezone}}"
  }
}
```

**Using Variables in Prompt Templates:**
```json
{
  "prompt": {
    "en": "Hello {{user_name}}, analyze this document considering it's {{date}} in {{timezone}}: {{content}}"
  }
}
```

#### Best Practices

1. **Keep Context Concise:** While powerful, avoid creating overly long context strings that consume token budget unnecessarily
2. **Use Relevant Variables:** Only include variables that add value to your use case
3. **Consider Privacy:** Be mindful when including user information like email addresses in prompts
4. **Test Thoroughly:** Verify that variable substitution works correctly across different user scenarios (authenticated, anonymous, different timezones)
5. **Locale-Aware Formatting:** Date and time formats automatically adapt to the user's locale setting
6. **Fallback Values:** Most user-specific variables (like `user_name`, `user_email`, `location`) will be empty strings for anonymous users

#### Variable Priority

When the same variable name appears in multiple places:

1. **User-defined variables** (from app variable forms) have highest priority
2. **Global prompt variables** are used as fallback
3. Variables in the `context` string are resolved first, then the result is available as `{{platform_context}}`

#### Advanced Configuration

**Dynamic Multi-Language Context:**
```json
{
  "globalPromptVariables": {
    "context": "IMPORTANT CONTEXT:\n- Current date: {{date}} ({{day_of_week}})\n- Time: {{time}} in {{timezone}}\n- User: {{user_name}}\n- Language: {{locale}}\n- Model: {{model_name}}\n\nWhen users ask about 'today', 'now', 'latest', or 'recent' information, remember that your knowledge may be outdated. The current date is {{date}}."
  }
}
```

**Minimal Context for Token Efficiency:**
```json
{
  "globalPromptVariables": {
    "context": "Date: {{date}} | TZ: {{timezone}} | Lang: {{locale}}"
  }
}
```

#### Troubleshooting

**Variables Not Resolving:**
- Ensure variable names are spelled correctly with proper casing
- Check that variables are wrapped in double curly braces: `{{variable_name}}`
- Verify the platform configuration is valid JSON

**Empty Values:**
- `user_name`, `user_email`, and `location` will be empty for anonymous users
- `tone` will be empty if no style/tone is selected
- `model_name` may be empty if using default model

**Date/Time Issues:**
- Verify the user's timezone is properly configured
- Check that the `defaultLanguage` in platform.json matches your locale expectations
- Date and time formatting follows the user's locale setting automatically

### **pdfExport**
Configuration for PDF export functionality.

- **defaultTemplate** (string) – Default template to use for PDF exports. Default: `"default"`
- **watermark** (object) – Watermark configuration
  - **enabled** (boolean) – Enable/disable watermark
  - **text** (string) – Watermark text
  - **position** (string) – Position (e.g., "bottom-right")
  - **opacity** (number) – Opacity level (0.0-1.0)
- **templates** (object) – Available PDF export templates with name and description

### **Request Configuration**

- **defaultLanguage** (string) – Fallback language code when requested language is unavailable. Default: `"en"`
- **requestBodyLimitMB** (number) – Maximum size of JSON request bodies in megabytes. Default: `50`
- **requestConcurrency** (number) – Default concurrency level for outbound requests. If omitted or below `1`, concurrency is unlimited. Default: `5`
- **requestDelayMs** (number) – Default delay in milliseconds between outbound requests. Default: `0`

### **telemetry**
OpenTelemetry integration configuration.

- **enabled** (boolean) – Enable telemetry collection. Default: `false`
- **metrics** (boolean) – Export metrics via Prometheus. Default: `true`
- **traces** (boolean) – Enable trace collection. Default: `true`
- **logs** (boolean) – Enable log collection. Default: `true`
- **port** (number) – Port for metrics export. Default: `9464`

## CORS Configuration

iHub Apps provides comprehensive CORS support for embedding and integration with other web applications.

```json
{
  "cors": {
    "origin": ["http://localhost:3000", "http://localhost:5173", "${ALLOWED_ORIGINS}"],
    "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
    "allowedHeaders": [
      "Content-Type",
      "Authorization", 
      "X-Requested-With",
      "X-Forwarded-User",
      "X-Forwarded-Groups",
      "Accept",
      "Origin",
      "Cache-Control",
      "X-File-Name"
    ],
    "credentials": true,
    "optionsSuccessStatus": 200,
    "maxAge": 86400,
    "preflightContinue": false
  }
}
```

### CORS Options

- **origin** (array|string|boolean) – Allowed origins. Supports environment variable replacement with `${ALLOWED_ORIGINS}`
- **methods** (array) – Allowed HTTP methods
- **allowedHeaders** (array) – Headers allowed in requests
- **credentials** (boolean) – Enable credentials support. Default: `true`
- **optionsSuccessStatus** (number) – Status code for successful OPTIONS requests. Default: `200`
- **maxAge** (number) – Preflight cache duration in seconds. Default: `86400`
- **preflightContinue** (boolean) – Continue to next handler after preflight. Default: `false`

### Environment Variable Support

CORS origins support dynamic configuration via environment variables:

```bash
# Development (automatically includes localhost:3000 and localhost:5173)
# No environment variables needed

# Production - single domain
export ALLOWED_ORIGINS="https://yourdomain.com"

# Production - multiple domains (comma-separated)
export ALLOWED_ORIGINS="https://yourdomain.com,https://app.yourdomain.com"
```

## Admin Configuration

### **admin**
Administrative interface configuration.

Admin access is controlled entirely through user group permissions. Users must have `adminAccess: true` in their group configuration to access the admin panel.

- **pages** (object) – Enable/disable individual admin pages. Each property defaults to `true` when omitted

Example admin pages configuration:
```json
{
  "admin": {
    "pages": {
      "usage": false,
      "models": true,
      "apps": true,
      "prompts": true,
      "users": true,
      "groups": true
    }
  }
}
```

### **swagger**
API documentation configuration.

- **enabled** (boolean) – Enable Swagger API documentation. Default: `true`
- **requireAuth** (boolean) – Require authentication to access Swagger UI. Default: `true`

### **refreshSalt**
Cache invalidation mechanism (automatically managed).

- **salt** (number) – Current salt value for cache invalidation
- **lastUpdated** (string) – ISO timestamp of last salt update

## Authentication Configuration

iHub Apps supports multiple authentication modes including anonymous access, local authentication, OIDC providers, and proxy-based authentication.

### **auth**
Core authentication configuration.

```json
{
  "auth": {
    "mode": "local",
    "authenticatedGroup": "authenticated",
    "sessionTimeoutMinutes": 480,
    "jwtSecret": "magic-secret"
  }
}
```

- **mode** (string) – Authentication mode. Options: `"proxy"`, `"local"`, `"oidc"`, `"anonymous"`. Default: `"proxy"`
- **authenticatedGroup** (string) – Group name assigned to authenticated users. Default: `"authenticated"`
- **sessionTimeoutMinutes** (number) – Session timeout in minutes for local auth. Default: `480`
- **jwtSecret** (string) – JWT signing secret. Supports environment variables like `"${JWT_SECRET}"`

### **anonymousAuth**
Configuration for anonymous (unauthenticated) access.

```json
{
  "anonymousAuth": {
    "enabled": true,
    "defaultGroups": ["anonymous"]
  }
}
```

- **enabled** (boolean) – Allow anonymous access to the platform. Default: `true`
- **defaultGroups** (array) – Groups assigned to anonymous users. Default: `["anonymous"]`

### **localAuth**
Built-in username/password authentication.

```json
{
  "localAuth": {
    "enabled": true,
    "usersFile": "contents/config/users.json",
    "showDemoAccounts": true
  }
}
```

- **enabled** (boolean) – Enable local authentication. Default: `false`
- **usersFile** (string) – Path to users configuration file. Default: `"contents/config/users.json"`
- **showDemoAccounts** (boolean) – Show demo accounts on login page. Default: `true`

### **proxyAuth**
Header-based authentication for reverse proxy setups.

```json
{
  "proxyAuth": {
    "enabled": false,
    "allowSelfSignup": false,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups",
    "jwtProviders": [
      {
        "name": "example-provider",
        "header": "Authorization",
        "issuer": "https://auth.example.com",
        "audience": "my-app",
        "jwkUrl": "https://auth.example.com/.well-known/jwks.json"
      }
    ]
  }
}
```

- **enabled** (boolean) – Enable proxy authentication. Default: `false`
- **allowSelfSignup** (boolean) – Allow automatic user creation. Default: `false`
- **userHeader** (string) – Header containing user ID. Default: `"X-Forwarded-User"`
- **groupsHeader** (string) – Header containing comma-separated groups. Default: `"X-Forwarded-Groups"`
- **jwtProviders** (array) – JWT validation configuration for proxy auth

### **oidcAuth**
OpenID Connect provider configuration.

```json
{
  "oidcAuth": {
    "enabled": false,
    "allowSelfSignup": false,
    "providers": [
      {
        "name": "microsoft",
        "displayName": "Microsoft",
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "authorizationURL": "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
        "tokenURL": "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
        "userInfoURL": "https://graph.microsoft.com/v1.0/me",
        "scope": ["openid", "profile", "email"],
        "groupsAttribute": "groups",
        "defaultGroups": ["users"],
        "pkce": true,
        "enabled": true,
        "autoRedirect": false
      }
    ]
  }
}
```

- **enabled** (boolean) – Enable OIDC authentication. Default: `false`
- **allowSelfSignup** (boolean) – Allow automatic user registration. Default: `false`
- **providers** (array) – OIDC provider configurations

#### OIDC Provider Configuration

- **name** (string) – Internal provider identifier
- **displayName** (string) – Display name shown to users
- **clientId** (string) – OAuth2 client ID
- **clientSecret** (string) – OAuth2 client secret
- **authorizationURL** (string) – OAuth2 authorization endpoint
- **tokenURL** (string) – OAuth2 token endpoint
- **userInfoURL** (string) – User information endpoint
- **scope** (array) – OAuth2 scopes. Default: `["openid", "profile", "email"]`
- **groupsAttribute** (string) – User info attribute containing groups. Default: `"groups"`
- **defaultGroups** (array) – Default groups for OIDC users. Default: `[]`
- **pkce** (boolean) – Enable PKCE for enhanced security. Default: `true`
- **enabled** (boolean) – Enable this provider. Default: `true`
- **autoRedirect** (boolean) – Automatically redirect to this provider. Default: `false`

### **authDebug**
Authentication debugging and logging configuration.

```json
{
  "authDebug": {
    "enabled": false,
    "maskTokens": true,
    "redactPasswords": true,
    "consoleLogging": false,
    "includeRawData": false,
    "providers": {
      "oidc": { "enabled": true },
      "local": { "enabled": true },
      "proxy": { "enabled": true },
      "ldap": { "enabled": true },
      "ntlm": { "enabled": true }
    }
  }
}
```

- **enabled** (boolean) – Enable authentication debugging. Default: `false`
- **maskTokens** (boolean) – Mask sensitive tokens in logs. Default: `true`
- **redactPasswords** (boolean) – Redact passwords from logs. Default: `true`
- **consoleLogging** (boolean) – Enable console logging. Default: `false`
- **includeRawData** (boolean) – Include raw authentication data. Default: `false`
- **providers** (object) – Per-provider debugging settings

## Environment Variables

Several platform configuration options support environment variable substitution using the `${VARIABLE_NAME}` syntax:

### Common Environment Variables

```bash
# Authentication
export JWT_SECRET="your-secret-key-here"

# CORS Configuration  
export ALLOWED_ORIGINS="https://yourdomain.com,https://app.yourdomain.com"

# OIDC Configuration
export OIDC_CLIENT_ID="your-oidc-client-id"
export OIDC_CLIENT_SECRET="your-oidc-client-secret"

# Database/Storage
export DATABASE_URL="postgresql://user:pass@localhost/db"
```

### Configuration Examples

**Development Setup:**
```json
{
  "auth": { "mode": "anonymous" },
  "anonymousAuth": { "enabled": true },
  "cors": {
    "origin": ["http://localhost:3000", "http://localhost:5173"]
  }
}
```

**Production Setup with OIDC:**
```json
{
  "auth": { "mode": "oidc" },
  "anonymousAuth": { "enabled": false },
  "oidcAuth": {
    "enabled": true,
    "providers": [{
      "name": "microsoft",
      "clientId": "${OIDC_CLIENT_ID}",
      "clientSecret": "${OIDC_CLIENT_SECRET}"
    }]
  },
  "cors": {
    "origin": ["${ALLOWED_ORIGINS}"],
    "credentials": true
  }
}
```

**Enterprise Proxy Setup:**
```json
{
  "auth": { "mode": "proxy" },
  "proxyAuth": {
    "enabled": true,
    "userHeader": "X-Forwarded-User",
    "groupsHeader": "X-Forwarded-Groups"
  },
  "anonymousAuth": { "enabled": false }
}
```
