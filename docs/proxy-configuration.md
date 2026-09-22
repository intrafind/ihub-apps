# Proxy Configuration

This document explains how to configure HTTP/HTTPS proxy support in iHub Apps.

## Overview

iHub Apps supports routing HTTP and HTTPS requests through a proxy server. This is useful when your infrastructure requires all outbound connections to go through a corporate proxy.

> This is the **outbound** proxy iHub uses for egress. It is unrelated to two
> similarly named settings: `proxyAuth` (inbound login via headers set by a
> reverse proxy, see [Authentication](external-authentication.md)) and
> `trustProxy` (how many inbound proxy hops to trust when resolving the client
> IP).

## Configuration

Proxy settings can be configured in multiple ways:

### 1. Admin UI (Recommended)

**Admin → Security → Outbound Proxy** edits the same settings without touching
any file:

- Switch proxying on or off, and set the HTTP and HTTPS proxy URLs
- Maintain the bypass list and the selective-proxy URL patterns, with invalid
  regular expressions flagged as you type
- See, per field, whether the value in effect comes from `platform.json` or from
  the environment
- Run a connectivity test against the settings on screen — saved or not — which
  reports how the URL is routed, whether the proxy itself answers, the HTTP
  status and timings, and a classified failure with a suggested next step

Saved changes take effect immediately; no restart is needed. Proxy URLs are
**encrypted at rest** in `platform.json` and the password is masked as
`***REDACTED***` everywhere it is displayed, logged or returned by the API —
leave the mask in place when saving to keep the stored password.

### 2. Platform Configuration

A fresh installation has **no `proxy` block at all** in
`contents/config/platform.json`, and nothing is proxied until you add one (or set
the environment variables below). Add it by hand, or let the admin UI write it:

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://proxy.example.com:8080",
    "https": "http://proxy.example.com:8080",
    "noProxy": "localhost,127.0.0.1,.local"
  }
}
```

### 3. Environment Variables

Set the following environment variables in your `.env` file:

```bash
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1,.local
```

### Configuration Priority

The system checks for proxy settings in the following order:
1. Platform configuration (`platform.json`)
2. Application environment variables (`config.env`)
3. System environment variables

A field in `platform.json` may also hold an `${ENV_VAR}` placeholder (for
example `"https": "${HTTPS_PROXY}"`), which is resolved from the environment when
the configuration is loaded. If the variable is not set, the placeholder is
**ignored** rather than used as a proxy URL, and the admin UI says so next to the
field. Placeholders survive a save from the admin UI.

## Configuration Options

### `proxy.enabled`
- **Type**: Boolean
- **Default**: `true` (and an absent `proxy` block means the same thing)
- **Description**: Master switch for all outbound requests. Set it to `false` to go
  direct even when a proxy URL is configured here **or** in the environment —
  that is the only way to ignore `HTTP_PROXY`/`HTTPS_PROXY`.

  On its own this flag proxies nothing: with no `proxy.http`, `proxy.https` or
  environment variable set, every request goes direct whether it is `true` or
  absent. **Admin → Security → Outbound Proxy** says which of the three states
  an installation is in — routed through a named proxy, no proxy in use, or
  switched off.

### `proxy.http`
- **Type**: String
- **Description**: HTTP proxy URL for HTTP requests (e.g., `http://proxy.example.com:8080`)

### `proxy.https`
- **Type**: String
- **Description**: HTTPS proxy URL for HTTPS requests (e.g., `http://proxy.example.com:8080`)

### `proxy.noProxy`
- **Type**: Comma-separated string **or** array of strings — both are accepted and
  normalized to the same list
- **Description**: Hosts that should bypass the proxy
- **Examples**:
  - `"localhost,127.0.0.1"` or `["localhost", "127.0.0.1"]` - Bypass for local addresses
  - `.example.com` - Bypass for subdomains of example.com (not `example.com` itself)
  - `*.internal.local` - Same as `.internal.local`

Entry semantics:

| Entry              | Matches                                     | Does not match  |
| ------------------ | ------------------------------------------- | --------------- |
| `api.example.com`  | exactly that hostname                       | subdomains      |
| `.example.com`     | `api.example.com`, `a.b.example.com`        | `example.com`   |
| `*.example.com`    | same as `.example.com`                      | `example.com`, `notexample.com` |

**Not supported** (unlike some `NO_PROXY` implementations): CIDR ranges
(`10.0.0.0/8`), IP ranges, `host:port` entries (`example.com:8080`), and the
catch-all `*`. To disable proxying entirely, set `proxy.enabled` to `false`.

### `proxy.urlPatterns`
- **Type**: Array of strings (regex patterns)
- **Description**: Optional allowlist of regular expressions tested against the
  full URL. When the list is **empty, every URL is proxied**. When it has
  entries, **only** URLs matching at least one pattern are proxied and everything
  else goes direct.
- **Example**: `["api\\.openai\\.com", "api\\.anthropic\\.com"]`
- Patterns are compiled independently. An entry that is not a valid regular
  expression is skipped with a warning naming it, and the remaining patterns are
  still evaluated. The admin UI and the config API reject uncompilable patterns
  before they are saved.
- `noProxy` is evaluated first: a host in the bypass list goes direct even if it
  matches a pattern.

## Proxy Authentication

If your proxy requires authentication, include credentials in the proxy URL:

```json
{
  "proxy": {
    "http": "http://username:password@proxy.example.com:8080",
    "https": "http://username:password@proxy.example.com:8080"
  }
}
```

Credentials saved through the admin UI are encrypted at rest (the stored value
looks like `ENC[AES256_GCM,...]`, decrypted at runtime with the key in
`contents/.encryption-key`). A plaintext URL written by hand keeps working and is
encrypted the next time the configuration is saved from the admin UI. Passwords
are never returned by the API or written to the log in the clear; a proxy
answering `407` is reported as "the proxy requires authentication" by the
connectivity test.

## Examples

### Basic Corporate Proxy

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://10.151.2.26:8080",
    "https": "http://10.151.2.26:8080",
    "noProxy": "localhost,127.0.0.1"
  }
}
```

### Proxy with Authentication

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://user:pass@proxy.company.com:8080",
    "https": "http://user:pass@proxy.company.com:8080",
    "noProxy": "localhost,127.0.0.1,.internal,.local"
  }
}
```

### Selective Proxy for LLM APIs Only

```json
{
  "proxy": {
    "enabled": true,
    "https": "http://proxy.example.com:8080",
    "urlPatterns": [
      "api\\.openai\\.com",
      "api\\.anthropic\\.com",
      "generativelanguage\\.googleapis\\.com",
      "api\\.mistral\\.ai"
    ]
  }
}
```

## What Uses Proxy?

When proxy is enabled, the following components will route through the proxy:

1. **LLM API Requests**: All requests to OpenAI, Anthropic, Google, Mistral, etc.
2. **Web Search**: Brave Search API calls
3. **Integrations**: JIRA, Entra, iFinder, and other external integrations
4. **Tools**: Web content extraction, screenshot tools, etc.

## Admin API

All three endpoints require admin authentication and are documented in the
OpenAPI spec under the **Admin - Proxy** tag.

| Endpoint                   | Purpose                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/admin/proxy/config`  | The stored block, the configuration in effect, and the origin of each field. Passwords redacted.   |
| `PUT /api/admin/proxy/config`  | Validate and store the block, then refresh the cache. Encrypts URLs; keeps `${ENV_VAR}` verbatim.  |
| `POST /api/admin/proxy/test`   | Probe one URL. Body: `{ "url": "...", "timeoutMs": 10000, "config": { ... } }`.                    |

The test endpoint answers with the routing decision (`proxied`, `bypassed`,
`excluded`, `disabled`, `direct`), whether the proxy answered at TCP level, the
HTTP status, timings split between the proxy connection and the request, and a
`classification` with a `nextStep`:

| Classification        | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `ok`                  | The target answered with a non-error status                      |
| `http_error`          | Transport worked; the target returned 4xx/5xx                    |
| `proxy_unreachable`   | No TCP connection to the proxy                                   |
| `proxy_auth_required` | The proxy answered `407`                                         |
| `proxy_dns_failure`   | The proxy hostname does not resolve                              |
| `dns_failure`         | The target hostname does not resolve                             |
| `tls_failure`         | Certificate verification failed                                  |
| `timeout`             | No response within the timeout                                   |
| `target_unreachable`  | Direct connection to the target refused                          |
| `request_failed`      | Anything else — see the server log (component `HttpConfig`)      |

The test honors the SSRF allowlist: a target that resolves to a private IP is
refused unless the host is listed in `ssrf.allowedHosts` (Admin → Security →
SSRF Allowlist). It also applies the same SSL decision the real request would —
so a host covered by `ssl.ignoreInvalidCertificates` plus `ssl.domainWhitelist`
is not reported as a TLS failure the live traffic never sees, and the result says
when certificate validation was relaxed. Redirects are not followed and no
response body is fetched or returned. Passing `config` probes a draft
configuration; nothing is saved.

## Troubleshooting

The quickest check is **Admin → Security → Outbound Proxy → Test connectivity**:
it names the routing decision, whether the proxy itself answers, and what to
check next. The scenarios below are what its classifications mean in practice.

### Proxy Connection Timeout

If you see timeout errors like:
```
ConnectTimeoutError: Connect Timeout Error (attempted address: api.example.com:443)
```

Check that:
1. The proxy URL is correct and accessible
2. The proxy server is running and accepting connections
3. Your firewall allows connections to the proxy
4. Proxy authentication credentials are correct (if required)

### SSL Certificate Issues

If you encounter SSL certificate errors with your proxy, you can configure the application to ignore invalid certificates:

```json
{
  "ssl": {
    "ignoreInvalidCertificates": true
  },
  "proxy": {
    "enabled": true,
    "https": "http://proxy.example.com:8080"
  }
}
```

**Warning**: Only use `ignoreInvalidCertificates` in development or when you trust your proxy server.

### Debugging Proxy Issues

Enable debug logging to see proxy activity:

```bash
NODE_DEBUG=http,https node server/server.js
```

Look for log messages like:
```
Using proxy http://10.151.2.26:8080 for URL: https://api.openai.com/...
```

## Technical Details

The proxy implementation uses:
- `http-proxy-agent` for HTTP requests
- `https-proxy-agent` for HTTPS requests
- `node-fetch` for compatibility with proxy agents

The system automatically switches between native `fetch()` and `node-fetch` based on whether a proxy is configured, ensuring optimal performance when no proxy is needed.
