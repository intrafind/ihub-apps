# Proxy Support Fix - Testing Guide

This guide helps you verify that the proxy support fix is working correctly.

## Quick Test

### 1. Configure Proxy

Edit `contents/config/platform.json` and add:

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://your-proxy-server:8080",
    "https": "http://your-proxy-server:8080",
    "noProxy": "localhost,127.0.0.1"
  },
  // ... rest of config
}
```

### 2. Restart the Server

```bash
npm run server
```

### 3. Check Logs

When making an LLM request, you should see log messages like:

```
Using proxy http://your-proxy-server:8080 for URL: https://api.openai.com/v1/chat/completions
```

### 4. Test LLM Request

Make a test request through the UI or API to any configured LLM model. If the proxy is working:
- ✅ The request should succeed (assuming your proxy allows the connection)
- ✅ Logs show "Using proxy..." messages
- ✅ No timeout errors

## Expected Behavior

### With Proxy Enabled

**Before the fix:**
```
Using proxy http://10.151.2.26:8080 for URL: https://aif-curie-1.cognitiveservices.azure.com/...
TypeError: fetch failed
  cause: ConnectTimeoutError: Connect Timeout Error (attempted address: aif-curie-1.cognitiveservices.azure.com:443)
```

**After the fix:**
```
Using proxy http://10.151.2.26:8080 for URL: https://aif-curie-1.cognitiveservices.azure.com/...
[Request succeeds through proxy]
```

### Without Proxy (Default)

If no proxy is configured, the behavior is unchanged:
- Uses native `fetch()` for optimal performance
- No proxy-related log messages
- Direct connections to LLM APIs

## Configuration Examples

### Corporate Proxy

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://proxy.company.com:8080",
    "https": "http://proxy.company.com:8080",
    "noProxy": "localhost,127.0.0.1,.internal,.local"
  }
}
```

### Proxy with Authentication

```json
{
  "proxy": {
    "enabled": true,
    "http": "http://username:password@proxy.company.com:8080",
    "https": "http://username:password@proxy.company.com:8080"
  }
}
```

### Test with Mock Proxy

You can test with a local proxy like `mitmproxy`:

```bash
# Install mitmproxy
pip install mitmproxy

# Start proxy on port 8080
mitmproxy -p 8080

# Configure iHub to use it
{
  "proxy": {
    "enabled": true,
    "http": "http://localhost:8080",
    "https": "http://localhost:8080"
  }
}
```

## Troubleshooting

### Still Getting Timeout Errors?

1. **Check proxy is reachable:**
   ```bash
   curl -x http://your-proxy:8080 https://api.openai.com
   ```

2. **Check proxy allows HTTPS:**
   - Most proxies need CONNECT method support for HTTPS
   - Some corporate proxies block AI API domains

3. **Check credentials:**
   - If proxy requires authentication, ensure username:password is correct
   - Try URL encoding special characters in password

4. **Test without SSL verification (dev only):**
   ```json
   {
     "ssl": {
       "ignoreInvalidCertificates": true
     },
     "proxy": {
       "enabled": true,
       "https": "http://your-proxy:8080"
     }
   }
   ```

### Debugging

Enable Node.js debug logging:
```bash
NODE_DEBUG=http,https,fetch npm run server
```

Check the logs for:
- "Using proxy..." messages confirming proxy is being used
- Connection details and any errors
- HTTP/HTTPS protocol details

## What Gets Proxied?

With proxy enabled, these requests go through the proxy:
- ✅ LLM API requests (OpenAI, Anthropic, Google, Mistral, etc.)
- ✅ Web search APIs (Brave, Tavily)
- ✅ Integration services (JIRA, Entra/Azure AD, iFinder)
- ✅ Tool requests (web content extraction, screenshot tools)

## Performance Impact

- **Without proxy:** Uses native `fetch()` - optimal performance
- **With proxy:** Uses `node-fetch` - negligible performance difference for typical use cases
- The switch is automatic based on configuration

## Security Notes

1. **Credentials in Config:** If storing proxy credentials in `platform.json`, ensure file permissions are restricted
2. **Environment Variables:** Consider using environment variables for sensitive proxy credentials
3. **SSL Verification:** Only disable SSL verification (`ignoreInvalidCertificates: true`) in development or when you trust your proxy
4. **Proxy Logs:** Be aware that proxy servers can log all traffic including API requests

## Support

If you encounter issues:
1. Check server logs for "Using proxy..." messages
2. Verify proxy configuration is correct
3. Test proxy connectivity independently
4. Check if proxy allows connections to AI API domains
5. Report issues with full error messages and proxy configuration (redact credentials)
