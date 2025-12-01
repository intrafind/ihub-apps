# Proxy Configuration

This document explains how to configure HTTP/HTTPS proxy support in iHub Apps.

## Overview

iHub Apps supports routing HTTP and HTTPS requests through a proxy server. This is useful when your infrastructure requires all outbound connections to go through a corporate proxy.

## Configuration

Proxy settings can be configured in multiple ways:

### 1. Platform Configuration (Recommended)

Add proxy configuration to your `contents/config/platform.json`:

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

### 2. Environment Variables

Set the following environment variables in your `.env` file:

```bash
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1,.local
```

### 3. Configuration Priority

The system checks for proxy settings in the following order:
1. Platform configuration (`platform.json`)
2. Application environment variables (`config.env`)
3. System environment variables

## Configuration Options

### `proxy.enabled`
- **Type**: Boolean
- **Default**: `true`
- **Description**: Enable or disable proxy for all requests. Set to `false` to bypass proxy even if URLs are configured.

### `proxy.http`
- **Type**: String
- **Description**: HTTP proxy URL for HTTP requests (e.g., `http://proxy.example.com:8080`)

### `proxy.https`
- **Type**: String
- **Description**: HTTPS proxy URL for HTTPS requests (e.g., `http://proxy.example.com:8080`)

### `proxy.noProxy`
- **Type**: String
- **Description**: Comma-separated list of hosts that should bypass the proxy
- **Examples**:
  - `localhost,127.0.0.1` - Bypass for local addresses
  - `.example.com` - Bypass for all subdomains of example.com
  - `*.internal.local` - Bypass for wildcard patterns

### `proxy.urlPatterns`
- **Type**: Array of strings (regex patterns)
- **Description**: Optional array of regex patterns to selectively apply proxy only to matching URLs
- **Example**: `["api\\.openai\\.com", "api\\.anthropic\\.com"]`

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
2. **Web Search**: Brave Search and Tavily Search API calls
3. **Integrations**: JIRA, Entra, iFinder, and other external integrations
4. **Tools**: Web content extraction, screenshot tools, etc.

## Troubleshooting

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

**Fixed in v4.3.9+**: SSL certificate validation settings now properly apply to destination servers when using proxy mode.

If you encounter SSL certificate errors with destination servers (not the proxy itself) when using a proxy, you can configure the application to ignore invalid certificates:

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

This configuration will:
- Use standard SSL validation for the connection to the proxy server
- Ignore SSL certificate errors when the proxy connects to the destination server
- Apply to all HTTPS requests routed through the proxy

**Warning**: Only use `ignoreInvalidCertificates` in development or when you trust your network environment and destination servers.

**Note**: If the proxy server itself uses a self-signed certificate, you may need to add the proxy's certificate to your system's trust store. See [SSL Certificates Documentation](ssl-certificates.md) for details.

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
