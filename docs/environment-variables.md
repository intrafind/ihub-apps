# Environment Variables

iHub Apps supports two categories of environment variable configuration:

1. **Standard variables** – well-known variables that control server behaviour (port, API keys, proxy, …).
2. **`IHUB_*` config overrides** – a systematic mapping that lets you override _any_ JSON config value from the environment, ideal for Docker and Kubernetes deployments.

---

## Standard Environment Variables

See [Server Configuration](server-config.md) for the full table of standard variables (`PORT`, `OPENAI_API_KEY`, `AUTH_MODE`, etc.).

---

## IHUB_* Config Overrides

Every field in `platform.json` and `ui.json` can be overridden with an environment variable that follows this naming convention:

```
IHUB_<CONFIG>__<SEGMENT1>__<SEGMENT2>__…=value
```

| Part | Description |
|------|-------------|
| `IHUB_` | Mandatory prefix |
| `<CONFIG>` | Config file identifier: `PLATFORM` or `UI` |
| `__` | **Double underscore** — separates the config identifier and each nested path segment |
| `<SEGMENT>` | Path segment in `UPPER_SNAKE_CASE`; automatically converted to `camelCase` |

### Type coercion

Values are automatically cast to the appropriate type:

| Env value | Result |
|-----------|--------|
| `true` / `false` | boolean |
| `42` / `3.14` | number |
| `["a","b"]` | JSON array |
| `{"k":"v"}` | JSON object |
| anything else | string |

### Supported config files

| `<CONFIG>` prefix | Config file |
|-------------------|-------------|
| `PLATFORM` | `contents/config/platform.json` |
| `UI` | `contents/config/ui.json` |

---

## Examples

### Platform configuration

```bash
# Authentication mode (platform.json → auth.mode)
IHUB_PLATFORM__AUTH__MODE=anonymous

# Default UI language (platform.json → defaultLanguage)
IHUB_PLATFORM__DEFAULT_LANGUAGE=de

# Session timeout in minutes (platform.json → auth.sessionTimeoutMinutes)
IHUB_PLATFORM__AUTH__SESSION_TIMEOUT_MINUTES=60

# Default rate limit (platform.json → rateLimit.default.limit)
IHUB_PLATFORM__RATE_LIMIT__DEFAULT__LIMIT=200

# Admin API rate limit (platform.json → rateLimit.adminApi.limit)
IHUB_PLATFORM__RATE_LIMIT__ADMIN_API__LIMIT=50

# Disable anonymous access (platform.json → anonymousAuth.enabled)
IHUB_PLATFORM__ANONYMOUS_AUTH__ENABLED=false

# Enable telemetry (platform.json → telemetry.enabled)
IHUB_PLATFORM__TELEMETRY__ENABLED=true

# Set logging level (platform.json → logging.level)
IHUB_PLATFORM__LOGGING__LEVEL=debug

# Enable Swagger UI (platform.json → swagger.enabled)
IHUB_PLATFORM__SWAGGER__ENABLED=false

# SSL – ignore invalid certificates (platform.json → ssl.ignoreInvalidCertificates)
IHUB_PLATFORM__SSL__IGNORE_INVALID_CERTIFICATES=true

# iFinder integration base URL (platform.json → iFinder.baseUrl)
IHUB_PLATFORM__I_FINDER__BASE_URL=https://ifinder.example.com
```

### UI configuration

```bash
# Primary theme colour (ui.json → theme.primaryColor)
IHUB_UI__THEME__PRIMARY_COLOR=#4f46e5

# Dark mode background (ui.json → theme.darkMode.backgroundColor)
IHUB_UI__THEME__DARK_MODE__BACKGROUND_COLOR=#1a1a2e

# PWA display name (ui.json → pwa.name)
IHUB_UI__PWA__NAME=My Company AI Hub

# Enable PWA (ui.json → pwa.enabled)
IHUB_UI__PWA__ENABLED=true
```

### Docker Compose example

```yaml
services:
  ihub:
    image: ghcr.io/intrafind/ihub-apps:latest
    environment:
      # Standard variables
      PORT: "3000"
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
      # IHUB_* overrides
      IHUB_PLATFORM__AUTH__MODE: "anonymous"
      IHUB_PLATFORM__DEFAULT_LANGUAGE: "de"
      IHUB_PLATFORM__RATE_LIMIT__DEFAULT__LIMIT: "200"
      IHUB_PLATFORM__LOGGING__LEVEL: "info"
      IHUB_UI__PWA__ENABLED: "true"
      IHUB_UI__THEME__PRIMARY_COLOR: "#003557"
```

### Kubernetes ConfigMap / Secret example

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ihub-config
data:
  IHUB_PLATFORM__AUTH__MODE: "local"
  IHUB_PLATFORM__DEFAULT_LANGUAGE: "en"
  IHUB_PLATFORM__RATE_LIMIT__DEFAULT__LIMIT: "500"
  IHUB_UI__THEME__PRIMARY_COLOR: "#003557"
---
apiVersion: v1
kind: Secret
metadata:
  name: ihub-secrets
type: Opaque
stringData:
  OPENAI_API_KEY: "sk-..."
  IHUB_PLATFORM__I_FINDER__BASE_URL: "https://ifinder.internal"
```

---

## Naming convention reference

Path segments in the environment variable name are written in `UPPER_SNAKE_CASE` and automatically converted to `camelCase` when applied to the JSON config:

| Env segment | JSON key |
|-------------|----------|
| `AUTH` | `auth` |
| `MODE` | `mode` |
| `DEFAULT_LANGUAGE` | `defaultLanguage` |
| `SESSION_TIMEOUT_MINUTES` | `sessionTimeoutMinutes` |
| `RATE_LIMIT` | `rateLimit` |
| `ADMIN_API` | `adminApi` |
| `IGNORE_INVALID_CERTIFICATES` | `ignoreInvalidCertificates` |
| `PRIMARY_COLOR` | `primaryColor` |
| `DARK_MODE` | `darkMode` |
| `BACKGROUND_COLOR` | `backgroundColor` |

---

## Precedence

Environment variable overrides are applied **after** the JSON config is loaded and `${VAR}` placeholders are resolved. This means:

1. `contents/config/platform.json` (or `ui.json`) is read from disk
2. `${VAR_NAME}` placeholders in string values are replaced
3. `IHUB_*` overrides are applied on top

The IHUB_* value always wins over the JSON file value.

---

## Logging

Each applied override is logged at `INFO` level with the component `ConfigCache`:

```
Applied IHUB env override: IHUB_PLATFORM__AUTH__MODE → auth.mode = "anonymous"
Applied IHUB env override: IHUB_PLATFORM__DEFAULT_LANGUAGE → defaultLanguage = "de"
```

This makes it easy to verify that overrides are being picked up during startup.
