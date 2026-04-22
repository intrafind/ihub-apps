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

- **export** (boolean) – Enables or disables all export functionality including JSON, JSONL, Markdown, HTML, and PDF exports for chat conversations and canvas content. When disabled, all export buttons and menus are hidden across the platform. Default: `true`
- **pdfExport** (boolean) – Enables or disables PDF export functionality specifically. Only applies when `export` is also enabled. Default: `true`
- **usageTracking** (boolean) – Enables or disables recording of usage statistics in `contents/data/usage.json`. Default: `true`

**Note:** The `export` feature flag acts as a master switch for all export functionality. The `pdfExport` flag provides granular control over PDF exports specifically, but requires `export` to be enabled to take effect.

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

**Important:** PDF export functionality requires both the `export` feature flag and the `pdfExport` feature flag to be enabled. The general `export` flag controls all export functionality, while `pdfExport` specifically controls the PDF export option.

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

- **mode** (string) – Authentication mode. Options: `"proxy"`, `"local"`, `"oidc"`, `"ldap"`, `"ntlm"`, `"anonymous"`. Default: `"local"`
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

### **ldapAuth**
LDAP directory authentication configuration. Allows users to log in using their corporate LDAP credentials.

```json
{
  "ldapAuth": {
    "enabled": true,
    "allowSelfSignup": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "displayName": "Corporate Directory",
        "url": "ldap://ldap.company.com:389",
        "adminDn": "cn=admin,dc=company,dc=com",
        "adminPassword": "${LDAP_ADMIN_PASSWORD}",
        "userSearchBase": "ou=users,dc=company,dc=com",
        "usernameAttribute": "uid",
        "groupSearchBase": "ou=groups,dc=company,dc=com",
        "groupClass": "groupOfNames",
        "groupMemberAttribute": "member",
        "groupMemberUserAttribute": "dn",
        "defaultGroups": ["users"],
        "sessionTimeoutMinutes": 480
      }
    ]
  }
}
```

- **enabled** (boolean) – Enable LDAP authentication. Default: `false`
- **allowSelfSignup** (boolean) – Automatically create user accounts on first login. Default: `true`
- **providers** (array) – One or more LDAP provider configurations

#### LDAP Provider Configuration

| Property                    | Type   | Default | Description                                                                        |
| --------------------------- | ------ | ------- | ---------------------------------------------------------------------------------- |
| `name`                      | String | -       | Internal identifier for this LDAP provider                                         |
| `displayName`               | String | -       | Human-readable name shown on the login page                                        |
| `url`                       | String | -       | LDAP server URL (e.g., `ldap://host:389` or `ldaps://host:636`)                   |
| `adminDn`                   | String | -       | Distinguished name used to bind and search the directory                           |
| `adminPassword`             | String | -       | Password for the admin DN. Encrypted at rest; supports `${ENV_VAR}` references    |
| `userSearchBase`            | String | -       | Base DN under which to search for users                                            |
| `usernameAttribute`         | String | `"uid"` | LDAP attribute containing the username                                             |
| `userDn`                    | String | -       | DN template for direct bind (alternative to admin search)                          |
| `groupSearchBase`           | String | -       | Base DN under which to search for groups                                           |
| `groupClass`                | String | -       | Object class used for group entries (e.g., `groupOfNames`, `posixGroup`)          |
| `groupMemberAttribute`      | String | -       | Group attribute listing members (e.g., `member`, `memberUid`)                     |
| `groupMemberUserAttribute`  | String | -       | User attribute referenced by `groupMemberAttribute` (e.g., `dn`, `uid`)           |
| `defaultGroups`             | Array  | `[]`    | Groups automatically assigned to all LDAP-authenticated users                     |
| `sessionTimeoutMinutes`     | Number | `480`   | Session lifetime in minutes                                                        |
| `tlsOptions`                | Object | -       | Node.js TLS options passed to the LDAP client (e.g., `{"rejectUnauthorized": false}`) |

For detailed setup instructions see [LDAP/NTLM Authentication](ldap-ntlm-authentication.md).

### **ntlmAuth**
Windows NTLM/Kerberos authentication for domain-joined environments.

```json
{
  "ntlmAuth": {
    "enabled": true,
    "domain": "COMPANY",
    "domainController": "dc.company.com",
    "type": "ntlm",
    "debug": false,
    "getUserInfo": true,
    "getGroups": true,
    "defaultGroups": ["users"],
    "sessionTimeoutMinutes": 480,
    "generateJwtToken": true
  }
}
```

| Property                    | Type    | Default  | Description                                                                                          |
| --------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `enabled`                   | Boolean | `false`  | Enable NTLM authentication                                                                           |
| `domain`                    | String  | -        | Windows domain name (NetBIOS format, e.g., `COMPANY`)                                               |
| `domainController`          | String  | -        | Domain controller hostname or IP address                                                             |
| `type`                      | String  | `"ntlm"` | Authentication protocol: `"ntlm"` or `"negotiate"` (Kerberos with NTLM fallback)                   |
| `debug`                     | Boolean | `false`  | Enable verbose NTLM debugging output                                                                 |
| `getUserInfo`               | Boolean | `true`   | Fetch user display name and email from Active Directory after authentication                         |
| `getGroups`                 | Boolean | `true`   | Fetch group memberships from Active Directory                                                        |
| `domainControllerUser`      | String  | -        | Service account username for AD lookups (required when `getUserInfo` or `getGroups` is `true`)      |
| `domainControllerPassword`  | String  | -        | Service account password. Encrypted at rest; supports `${ENV_VAR}` references                       |
| `defaultGroups`             | Array   | `[]`     | Groups automatically assigned to all NTLM-authenticated users                                       |
| `sessionTimeoutMinutes`     | Number  | `480`    | Session lifetime in minutes                                                                          |
| `generateJwtToken`          | Boolean | `true`   | Issue a JWT token after successful NTLM authentication so subsequent requests use standard auth      |
| `options`                   | Object  | -        | Additional options passed directly to the underlying NTLM library                                   |

For detailed setup instructions see [LDAP/NTLM Authentication](ldap-ntlm-authentication.md).

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
# Authentication (JWT_SECRET is only needed when using HS256 algorithm)
export JWT_SECRET="your-secret-key-here"

# CORS Configuration
export ALLOWED_ORIGINS="https://yourdomain.com,https://app.yourdomain.com"

# OIDC Configuration
export OIDC_CLIENT_ID="your-oidc-client-id"
export OIDC_CLIENT_SECRET="your-oidc-client-secret"
```

> **Note:** iHub Apps stores all configuration and runtime data in JSON files. There is no SQL database. The `CONTENTS_DIR` environment variable controls where configuration files are read from, and `DATA_DIR` controls where runtime data (usage logs, etc.) is written. See [Server Configuration](server-config.md) for the full list of environment variables.

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

## Rate Limiting

iHub Apps enforces rate limits per route category to protect against abuse and ensure fair resource distribution. All limits are configured under the `rateLimit` key.

```json
{
  "rateLimit": {
    "default": {
      "windowMs": 60000,
      "limit": 100,
      "standardHeaders": true,
      "legacyHeaders": false,
      "skipSuccessfulRequests": false,
      "skipFailedRequests": true
    },
    "adminApi": {
      "windowMs": 60000,
      "limit": 100,
      "skipFailedRequests": true
    },
    "publicApi": {
      "windowMs": 60000,
      "limit": 500,
      "skipFailedRequests": true
    },
    "authApi": {
      "windowMs": 900000,
      "limit": 30,
      "skipFailedRequests": false
    },
    "oauthApi": {
      "windowMs": 900000,
      "limit": 50,
      "skipFailedRequests": false
    },
    "inferenceApi": {
      "windowMs": 60000,
      "limit": 500
    }
  }
}
```

### Rate Limit Categories

| Category       | Applies To                             | Default Window | Default Limit |
| -------------- | -------------------------------------- | -------------- | ------------- |
| `default`      | All routes not covered by other groups | 60 s           | 100           |
| `adminApi`     | `/api/admin/**` admin endpoints        | 60 s           | 100           |
| `publicApi`    | Public read-only endpoints             | 60 s           | 500           |
| `authApi`      | `/api/auth/**` login/logout/token      | 900 s (15 min) | 30            |
| `oauthApi`     | `/api/oauth/**` OAuth server endpoints | 900 s (15 min) | 50            |
| `inferenceApi` | `/api/chat/**` AI inference calls      | 60 s           | 500           |

### Rate Limit Configuration Fields

Each category accepts the following fields. Partial overrides inherit unset values from `default`:

| Field                    | Type    | Default | Description                                                                     |
| ------------------------ | ------- | ------- | ------------------------------------------------------------------------------- |
| `windowMs`               | Number  | 900000  | Time window in milliseconds. Minimum: `1000`                                    |
| `limit`                  | Number  | 100     | Maximum requests allowed per window per IP. Minimum: `1`                        |
| `message`                | String  | -       | Custom error message returned when the limit is exceeded                        |
| `standardHeaders`        | Boolean | `true`  | Include `RateLimit-*` headers in responses                                      |
| `legacyHeaders`          | Boolean | `false` | Include legacy `X-RateLimit-*` headers                                          |
| `skipSuccessfulRequests` | Boolean | `false` | Do not count successful (2xx) responses against the limit                       |
| `skipFailedRequests`     | Boolean | `false` | Do not count failed (4xx/5xx) responses against the limit                       |

For more information see [Rate Limiting](rate-limiting.md).

## SSL Configuration

Controls SSL/TLS certificate validation for outbound requests made by the server.

```json
{
  "ssl": {
    "ignoreInvalidCertificates": false,
    "domainWhitelist": [
      "*.internal.company.com",
      "api.legacy-system.example.com"
    ]
  }
}
```

| Field                       | Type    | Default | Description                                                                                                                                          |
| --------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoreInvalidCertificates` | Boolean | `false` | Disable SSL certificate validation for **all** outbound requests. Use only in development; never enable in production                                |
| `domainWhitelist`           | Array   | `[]`    | Domains or glob patterns for which SSL validation is skipped. Supports exact matches (`api.example.com`) and wildcards (`*.example.com`). Prefer this over `ignoreInvalidCertificates` |

For configuration details see [SSL Certificates](ssl-certificates.md).

## Logging

Configures server-side logging output.

```json
{
  "logging": {
    "level": "info",
    "format": "json",
    "file": {
      "enabled": false,
      "path": "logs/app.log",
      "maxSize": 10485760,
      "maxFiles": 5
    }
  }
}
```

| Field           | Type    | Default          | Description                                                                                        |
| --------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `level`         | String  | `"info"`         | Minimum log level. Options: `"error"`, `"warn"`, `"info"`, `"http"`, `"verbose"`, `"debug"`, `"silly"` |
| `format`        | String  | `"json"`         | Log output format: `"json"` (structured, for log aggregators) or `"text"` (human-readable)        |
| `file.enabled`  | Boolean | `false`          | Write logs to a file in addition to stdout                                                         |
| `file.path`     | String  | `"logs/app.log"` | Path to the log file                                                                               |
| `file.maxSize`  | Number  | `10485760`       | Maximum file size in bytes before rotation (default: 10 MB)                                        |
| `file.maxFiles` | Number  | `5`              | Number of rotated log files to keep                                                                |

For detailed guidance see [Logging](logging.md).

## JWT Configuration

Global JWT signing algorithm used when the server issues tokens (local auth, NTLM auth, etc.).

```json
{
  "jwt": {
    "algorithm": "RS256"
  }
}
```

| Field       | Type   | Default   | Description                                                                                                               |
| ----------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `algorithm` | String | `"RS256"` | JWT signing algorithm. `"RS256"` uses RSA public/private key pairs. Other values depend on the `jsonwebtoken` library (e.g., `"HS256"`, `"ES256"`) |

For key generation instructions see [JWT Key Generation](ifinder-jwt-key-generation.md).

## iFinder Integration

Configures integration with the IntraFind iFinder enterprise search platform. When enabled, iHub Apps generates signed JWT tokens to authenticate requests to iFinder on behalf of users.

```json
{
  "iFinder": {
    "enabled": false,
    "baseUrl": "https://ifinder.company.com",
    "privateKey": "${IFINDER_PRIVATE_KEY}",
    "algorithm": "RS256",
    "issuer": "ihub-apps",
    "audience": "ifinder-api",
    "tokenExpirationSeconds": 3600,
    "defaultScope": "fa_index_read",
    "jwtSubjectField": "email"
  }
}
```

| Field                    | Type    | Default           | Description                                                                             |
| ------------------------ | ------- | ----------------- | --------------------------------------------------------------------------------------- |
| `enabled`                | Boolean | `false`           | Enable the iFinder integration                                                          |
| `baseUrl`                | String  | `""`              | Base URL of the iFinder instance                                                        |
| `privateKey`             | String  | `""`              | RSA private key (PEM format) for signing JWT tokens. Use `${ENV_VAR}` for security     |
| `algorithm`              | String  | `"RS256"`         | JWT signing algorithm                                                                   |
| `issuer`                 | String  | `"ihub-apps"`     | JWT `iss` claim value                                                                   |
| `audience`               | String  | `"ifinder-api"`   | JWT `aud` claim value                                                                   |
| `tokenExpirationSeconds` | Number  | `3600`            | Lifetime of generated JWT tokens in seconds                                             |
| `defaultScope`           | String  | `"fa_index_read"` | Default OAuth scope included in generated tokens                                        |
| `jwtSubjectField`        | String  | `"email"`         | User attribute used as the JWT `sub` claim. Options: `"email"`, `"username"`           |

For integration details see [iFinder Integration](iFinder-Integration.md).

## iAssistant Integration

Configures the global connection to an IntraFind iAssistant service. Individual apps can override these settings via their `iassistant` property.

```json
{
  "iAssistant": {
    "baseUrl": "https://iassistant.company.com",
    "defaultProfileId": "main-search-profile",
    "timeout": 60000
  }
}
```

| Field              | Type   | Default | Description                                                                              |
| ------------------ | ------ | ------- | ---------------------------------------------------------------------------------------- |
| `baseUrl`          | String | `""`    | Base URL of the iAssistant service                                                       |
| `defaultProfileId` | String | `""`    | Profile ID used when an app does not specify its own `iassistant.profileId`              |
| `timeout`          | Number | `60000` | Request timeout in milliseconds for iAssistant API calls                                 |

## OAuth Server Configuration

iHub Apps can act as an OAuth 2.0 authorization server, issuing access tokens to registered third-party clients. This enables embedding iHub Apps capabilities into external applications.

```json
{
  "oauth": {
    "enabled": {
      "authz": false,
      "clients": false
    },
    "clientsFile": "contents/config/oauth-clients.json",
    "defaultTokenExpirationMinutes": 60,
    "maxTokenExpirationMinutes": 1440,
    "authorizationCodeEnabled": false,
    "issuer": "https://ihub.company.com",
    "authorizationCodeExpirationSeconds": 600,
    "refreshTokenEnabled": false,
    "refreshTokenExpirationDays": 30,
    "consentRequired": true,
    "consentMemoryDays": 90
  }
}
```

| Field                                | Type    | Default                                | Description                                                                             |
| ------------------------------------ | ------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `enabled.authz`                      | Boolean | `false`                                | Enable the built-in OAuth 2.0 authorization server (authorization code flow, JWKS, etc.) |
| `enabled.clients`                    | Boolean | `false`                                | Enable OAuth Clients (client credentials / static API key authentication). Can be toggled independently from the authorization server. |
| `clientsFile`                        | String  | `"contents/config/oauth-clients.json"` | Path to the registered OAuth clients configuration file                                 |
| `defaultTokenExpirationMinutes`      | Number  | `60`                                   | Default access token lifetime in minutes                                                |
| `maxTokenExpirationMinutes`          | Number  | `1440`                                 | Maximum allowed access token lifetime in minutes                                        |
| `authorizationCodeEnabled`           | Boolean | `false`                                | Enable the Authorization Code grant flow                                                |
| `issuer`                             | String  | `""`                                   | Token issuer (`iss` claim). Should be the public URL of this iHub Apps instance         |
| `authorizationCodeExpirationSeconds` | Number  | `600`                                  | Lifetime of authorization codes in seconds before they expire                          |
| `refreshTokenEnabled`                | Boolean | `false`                                | Enable refresh token issuance alongside access tokens                                   |
| `refreshTokenExpirationDays`         | Number  | `30`                                   | Refresh token lifetime in days                                                          |
| `consentRequired`                    | Boolean | `true`                                 | Require users to explicitly approve third-party client access                           |
| `consentMemoryDays`                  | Number  | `90`                                   | Days a user consent decision is remembered before re-prompting                          |

For setup and client registration see [OAuth Integration Guide](oauth-integration-guide.md).

## Cloud Storage Configuration

Configures OAuth-based cloud storage providers that users can browse and attach files from when the `upload.cloudStorageUpload` feature is enabled in an app.

```json
{
  "cloudStorage": {
    "enabled": true,
    "providers": [
      {
        "id": "office365-main",
        "name": "office365-main",
        "displayName": "Company SharePoint",
        "type": "office365",
        "enabled": true,
        "tenantId": "${AZURE_TENANT_ID}",
        "clientId": "${AZURE_CLIENT_ID}",
        "clientSecret": "${AZURE_CLIENT_SECRET}",
        "siteUrl": "https://company.sharepoint.com",
        "sources": {
          "personalDrive": true,
          "followedSites": true,
          "teams": true
        }
      },
      {
        "id": "google-drive-main",
        "name": "google-drive-main",
        "displayName": "Company Google Drive",
        "type": "googledrive",
        "enabled": true,
        "clientId": "${GOOGLE_CLIENT_ID}",
        "clientSecret": "${GOOGLE_CLIENT_SECRET}",
        "sources": {
          "myDrive": true,
          "sharedDrives": true,
          "sharedWithMe": true
        }
      }
    ]
  }
}
```

### Cloud Storage Top-Level Fields

| Field      | Type    | Default | Description                             |
| ---------- | ------- | ------- | --------------------------------------- |
| `enabled`  | Boolean | `false` | Enable cloud storage file picker        |
| `providers`| Array   | `[]`    | Array of cloud storage provider configs |

### Office 365 Provider Fields

| Field                     | Type    | Default | Description                                                                         |
| ------------------------- | ------- | ------- | ----------------------------------------------------------------------------------- |
| `id`                      | String  | -       | **Required.** Unique identifier for this provider instance                          |
| `name`                    | String  | -       | **Required.** Internal name                                                         |
| `displayName`             | String  | -       | **Required.** Name shown to users in the file picker                                |
| `type`                    | String  | -       | Must be `"office365"`                                                               |
| `enabled`                 | Boolean | `true`  | Enable or disable this provider                                                     |
| `tenantId`                | String  | -       | Azure tenant ID. Encrypted at rest; supports `${ENV_VAR}` references               |
| `clientId`                | String  | -       | Azure app registration client ID                                                    |
| `clientSecret`            | String  | -       | Azure app registration client secret. Encrypted at rest                             |
| `siteUrl`                 | String  | -       | SharePoint site URL (e.g., `https://company.sharepoint.com`)                        |
| `driveId`                 | String  | -       | Specific drive ID. If omitted, the user's default drive is used                    |
| `redirectUri`             | String  | -       | OAuth redirect URI (must match the Azure app registration)                          |
| `sources.personalDrive`   | Boolean | `true`  | Show the user's personal OneDrive                                                   |
| `sources.followedSites`   | Boolean | `true`  | Show SharePoint sites the user follows                                              |
| `sources.teams`           | Boolean | `true`  | Show files from Microsoft Teams channels                                            |

### Google Drive Provider Fields

| Field                     | Type    | Default | Description                                                         |
| ------------------------- | ------- | ------- | ------------------------------------------------------------------- |
| `id`                      | String  | -       | **Required.** Unique identifier for this provider instance          |
| `name`                    | String  | -       | **Required.** Internal name                                         |
| `displayName`             | String  | -       | **Required.** Name shown to users in the file picker                |
| `type`                    | String  | -       | Must be `"googledrive"`                                             |
| `enabled`                 | Boolean | `true`  | Enable or disable this provider                                     |
| `clientId`                | String  | -       | Google OAuth 2.0 client ID                                          |
| `clientSecret`            | String  | -       | Google OAuth 2.0 client secret. Encrypted at rest                   |
| `redirectUri`             | String  | -       | OAuth redirect URI                                                  |
| `sources.myDrive`         | Boolean | `true`  | Show the user's personal Google Drive                               |
| `sources.sharedDrives`    | Boolean | `true`  | Show shared drives (Team Drives)                                    |
| `sources.sharedWithMe`    | Boolean | `true`  | Show files shared with the user                                     |

For setup instructions see [Google Drive Integration](google-drive-integration.md).

## Skills Configuration

Configures the skills system, which provides reusable AI behaviors that can be attached to apps via the app's `skills` array.

```json
{
  "skills": {
    "skillsDirectory": "contents/skills",
    "maxSkillBodyTokens": 5000
  }
}
```

| Field                | Type   | Default              | Description                                                                           |
| -------------------- | ------ | -------------------- | ------------------------------------------------------------------------------------- |
| `skillsDirectory`    | String | `"contents/skills"` | Directory where skill definition files are stored                                     |
| `maxSkillBodyTokens` | Number | `5000`               | Maximum token count for the combined skill instructions injected into a conversation  |
