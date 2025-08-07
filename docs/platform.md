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
    "secret": "platform-secret",
    "encrypted": false,
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
Defines variables that are automatically injected into all prompts across the platform.

- **context** (string) – Global context string injected into prompts. Supports dynamic variables like `{{timezone}}`, `{{date}}`, etc.

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

- **secret** (string) – Admin authentication secret
- **encrypted** (boolean) – Whether the admin secret is encrypted. Default: `false`
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
