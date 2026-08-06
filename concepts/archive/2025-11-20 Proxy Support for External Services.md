# Proxy Support for External Services

**Date:** 2025-11-20  
**Status:** Implemented (Fixed 2025-11-28)  
**Type:** Feature Enhancement

## Overview

This feature adds comprehensive proxy support for all external HTTP/HTTPS calls made by the iHub Apps platform. This is essential for customers running iHub internally where all external calls must go through a corporate proxy.

## Bug Fix (2025-11-28)

### Issue
The proxy configuration was not working for LLM API requests. Users reported connection timeout errors when proxy was enabled:
```
ConnectTimeoutError: Connect Timeout Error (attempted address: aif-curie-1.cognitiveservices.azure.com:443, timeout: 10000ms)
```

### Root Cause
The original implementation created proxy agents correctly but used native Node.js `fetch()` API which does not support the `agent` option. The proxy agents (`http-proxy-agent` and `https-proxy-agent`) only work with:
- Node.js HTTP/HTTPS modules directly
- `node-fetch` library (v2/v3)
- `axios` library

Native `fetch()` (introduced in Node.js 18+) ignores the `agent` option, so proxy configuration was silently ignored.

### Fix
Modified `server/requestThrottler.js` to conditionally use `node-fetch` when a proxy agent is configured:
- When no proxy is configured: Uses native `fetch()` (optimal performance)
- When proxy is configured: Switches to `node-fetch` (proxy support)

Also updated `server/services/integrations/JiraService.js` to use `enhanceAxiosConfig()` for consistent proxy support across all integrations.

### Files Modified
- `server/requestThrottler.js` - Added conditional node-fetch usage
- `server/services/integrations/JiraService.js` - Added proxy support to axios calls

## Problem Statement

Customers operating iHub Apps in corporate environments require all external HTTP/HTTPS traffic to be routed through a proxy server. Without proxy support, the application cannot:
- Connect to external LLM providers (OpenAI, Anthropic, Google, Mistral)
- Authenticate with external identity providers (OIDC, OAuth2, Azure AD)
- Access external integrations (Jira, Microsoft Graph)
- Use external tools (web search, content extraction)

## Solution Design

### Configuration Hierarchy

The proxy configuration supports multiple levels of configuration with the following priority:

1. **Platform Configuration** (`contents/config/platform.json`)
2. **Environment Variables** (`.env` or system environment)
3. **Node.js Standard Environment Variables** (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`)

### Configuration Schema

#### Platform JSON Configuration

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://proxy.example.com:8080",
    "https": "http://proxy.example.com:8080",
    "noProxy": "localhost,127.0.0.1,.local,.internal",
    "urlPatterns": [
      ".*\\.atlassian\\.net.*",
      ".*jira.*"
    ]
  }
}
```

#### Environment Variables

```bash
# Global proxy settings (standard Node.js variables)
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1,.local

# These are also available through config.js
```

### Features

1. **Global Proxy Configuration**: Configure a single proxy for all external HTTP/HTTPS requests
2. **Protocol-Specific Proxies**: Separate proxy URLs for HTTP and HTTPS traffic
3. **NO_PROXY Support**: Bypass proxy for specific hosts/domains
   - Exact hostname match: `localhost`
   - Domain suffix match: `.example.com`
   - Wildcard domains: `*.example.com`
4. **Selective Proxy by URL Pattern**: Apply proxy only to URLs matching specific regex patterns
5. **SSL Certificate Handling**: Works seamlessly with existing SSL certificate ignore configuration
6. **Automatic Agent Creation**: Automatically creates appropriate proxy agents for fetch and axios

### Implementation Details

#### Core Files Modified

1. **`server/config.js`**
   - Added `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` environment variables
   - These integrate with Node.js standard proxy environment variables

2. **`server/utils/httpConfig.js`** (Primary Implementation)
   - Added `getProxyConfig()` - Retrieves proxy configuration from platform config and environment
   - Added `shouldBypassProxy()` - Checks if a URL should bypass proxy based on NO_PROXY rules
   - Added `matchesProxyPattern()` - Checks if URL matches selective proxy patterns
   - Added `createAgent()` - Creates appropriate HTTP/HTTPS/Proxy agent based on configuration
   - Enhanced `enhanceFetchOptions()` - Now supports proxy configuration
   - Enhanced `enhanceAxiosConfig()` - Now supports proxy configuration with URL parameter
   - Kept `createHTTPSAgent()` for backward compatibility (deprecated)

3. **`server/services/integrations/EntraService.js`**
   - Updated to pass URL to `enhanceAxiosConfig()` for proper proxy handling

4. **Configuration Files**
   - `examples/config/platform.json` - Added proxy configuration section
   - `config.env` - Added proxy environment variable documentation
   - `.env.example` - Added proxy environment variable documentation

#### Proxy Agent Packages

The implementation uses industry-standard proxy agent packages:
- `http-proxy-agent` (v7.0.2) - For HTTP proxy connections
- `https-proxy-agent` (v7.0.6) - For HTTPS proxy connections

These packages were already available as transitive dependencies through electron-builder and jest.

### How It Works

#### Request Flow with Proxy

1. **Configuration Loading**
   - On startup, proxy settings are loaded from platform.json and environment variables
   - Configuration is cached and retrieved via `getProxyConfig()`

2. **Request Preparation**
   - When a fetch or axios request is made, `enhanceFetchOptions()` or `enhanceAxiosConfig()` is called
   - These functions call `createAgent()` with the target URL

3. **Agent Creation Logic**
   ```
   createAgent(url) {
     1. Check if proxy is enabled
     2. Check if URL should bypass proxy (NO_PROXY rules)
     3. Check if URL matches selective proxy patterns (if configured)
     4. Create appropriate proxy agent with SSL settings
     5. Return agent (or undefined for no proxy)
   }
   ```

4. **Request Execution**
   - The created agent is attached to the request options
   - All traffic for that request flows through the configured proxy

#### Integration Points

The proxy support is automatically applied to all HTTP clients used in the platform:

1. **Fetch API** (Native Node.js + node-fetch fallback)
   - Used by: LLM adapters, tools, requestThrottler
   - Enhanced via: `enhanceFetchOptions()` in requestThrottler.js
   - **Important**: Automatically switches to `node-fetch` when proxy agent is present (native fetch doesn't support agent option)

2. **Axios**
   - Used by: Integration services (Jira, Entra/Azure AD)
   - Enhanced via: `enhanceAxiosConfig()` in respective service files

### Use Cases

#### Use Case 1: Global Proxy for All External Calls

**Configuration:**
```json
{
  "proxy": {
    "enabled": true,
    "http": "http://proxy.company.com:8080",
    "https": "http://proxy.company.com:8080",
    "noProxy": "localhost,127.0.0.1,.local"
  }
}
```

**Behavior:** All external HTTP/HTTPS calls go through the proxy, except for localhost and .local domains.

#### Use Case 2: Proxy Only for Jira Integration

**Configuration:**
```json
{
  "proxy": {
    "enabled": true,
    "https": "http://proxy.company.com:8080",
    "urlPatterns": [
      ".*\\.atlassian\\.net.*",
      ".*auth\\.atlassian\\.com.*"
    ]
  }
}
```

**Behavior:** Only requests to Jira/Atlassian URLs go through the proxy. All other requests bypass the proxy.

#### Use Case 3: Proxy with Internal Service Bypass

**Configuration:**
```json
{
  "proxy": {
    "enabled": true,
    "http": "http://proxy.company.com:8080",
    "https": "http://proxy.company.com:8080",
    "noProxy": "localhost,.internal,.company.com,10.0.0.0/8"
  }
}
```

**Behavior:** External calls use proxy, but internal services (.internal, .company.com domains) and local network (10.x.x.x) bypass proxy.

### Testing

Manual testing should verify:

1. **Proxy Connection**: Verify requests go through proxy when enabled
2. **NO_PROXY Rules**: Verify bypass rules work correctly
3. **Selective Proxy**: Verify urlPatterns correctly filter requests
4. **SSL + Proxy**: Verify SSL ignore works with proxy
5. **All HTTP Clients**: Test both fetch and axios clients
6. **All Services**: Test LLMs, authentication, integrations, and tools

### Configuration Reference

#### Platform JSON Schema

```typescript
interface ProxyConfig {
  enabled?: boolean;           // Default: false
  http?: string;              // HTTP proxy URL (e.g., "http://proxy:8080")
  https?: string;             // HTTPS proxy URL
  noProxy?: string;           // Comma-separated bypass list
  urlPatterns?: string[];     // Array of regex patterns for selective proxy
}
```

#### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `HTTP_PROXY` | HTTP proxy URL | `http://proxy.example.com:8080` |
| `HTTPS_PROXY` | HTTPS proxy URL | `http://proxy.example.com:8080` |
| `NO_PROXY` | Comma-separated bypass list | `localhost,127.0.0.1,.local` |

### Migration Guide

Existing installations do not require any changes. The proxy feature is opt-in:

1. **Enable via Platform JSON**:
   - Edit `contents/config/platform.json`
   - Add `proxy` section with desired configuration

2. **Enable via Environment Variables**:
   - Set `HTTP_PROXY` and/or `HTTPS_PROXY` in your environment
   - Optionally set `NO_PROXY` for bypass rules

3. **Restart the Application**:
   - The configuration is loaded on startup

### Future Enhancements

Possible future improvements:

1. **Proxy Authentication**: Support for proxy username/password
2. **SOCKS Proxy Support**: Support for SOCKS4/SOCKS5 proxies
3. **PAC File Support**: Automatic proxy configuration via PAC files
4. **Per-Service Proxy**: Different proxy settings for different services
5. **Proxy Health Monitoring**: Monitor and alert on proxy connection issues
6. **Dynamic Proxy Switching**: Runtime proxy configuration changes

### Related Files

- `server/config.js` - Environment variable configuration
- `server/utils/httpConfig.js` - Core proxy implementation
- `server/requestThrottler.js` - Fetch client integration
- `server/services/integrations/EntraService.js` - Axios client integration
- `examples/config/platform.json` - Configuration example
- `config.env` - Environment variable documentation
- `.env.example` - Environment variable example

### Dependencies

- `http-proxy-agent`: ^7.0.2
- `https-proxy-agent`: ^7.0.6

Both packages were already available as transitive dependencies, no new dependencies were added.

## Conclusion

This implementation provides comprehensive, flexible proxy support that integrates seamlessly with the existing architecture. It supports multiple configuration methods, selective proxying, and works with all HTTP clients in the platform.
