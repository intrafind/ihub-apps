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

2. **Test the exact failing integration directly**, bypassing the iHub app, so you can tell whether the proxy or the destination is the problem. The example below uses Brave Search — the same pattern (direct request vs. `-x <proxy>`, then the same request through iHub's own code) works for any integration; just swap the URL, headers and env var names.

   First check whether iHub even has a proxy configured for this environment: look for a top-level `proxy` block (with `http`/`https`/`noProxy` fields) in `contents/config/platform.json` — this is different from the unrelated `proxyAuth` reverse-proxy-login setting elsewhere in that file — and check `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` in `config.env` or the shell environment. The server also logs the result once at startup (component `HttpConfig`): `"Proxy configuration loaded"` with the URLs it found, or `"No proxy configured"` if nothing is set anywhere. Run the commands below from the iHub install directory (the one containing `server/`), since the last one imports a file by relative path.

   **Linux / macOS:**
   ```bash
   # What's configured?
   grep -A8 '"proxy"' contents/config/platform.json
   env | grep -i _proxy

   # Direct request to Brave (bypasses the proxy) — mirrors what iHub sends
   curl -sS -v --connect-timeout 10 --max-time 20 \
     -H "X-Subscription-Token: YOUR_BRAVE_API_KEY" \
     -H "Accept: application/json" \
     "https://api.search.brave.com/res/v1/web/search?q=test"

   # Same request, explicitly through the proxy iHub is configured to use
   curl -sS -v --connect-timeout 10 --max-time 20 \
     -x "http://your-proxy:8080" \
     -H "X-Subscription-Token: YOUR_BRAVE_API_KEY" \
     -H "Accept: application/json" \
     "https://api.search.brave.com/res/v1/web/search?q=test"

   # Best fidelity: run the request through iHub's own code (same proxy
   # agent, retry and SSL logic the live server uses) and print the result
   BRAVE_SEARCH_API_KEY="YOUR_BRAVE_API_KEY" \
   HTTPS_PROXY="http://your-proxy:8080" \
   node --input-type=module -e "
   import braveSearch from './server/tools/braveSearch.js';
   const result = await braveSearch({ query: 'test', maxResults: 3 });
   console.log(JSON.stringify(result, null, 2));
   "
   ```

   **Windows (Command Prompt):** env vars need `set NAME=value && command` instead of a bash prefix, and double quotes instead of single quotes — cmd does not treat `'` as a quote character.
   ```bat
   :: What's configured?
   findstr /I "proxy" contents\config\platform.json
   set | findstr /I _proxy

   :: Direct request to Brave (bypasses the proxy)
   curl -sS -v --connect-timeout 10 --max-time 20 -H "X-Subscription-Token: YOUR_BRAVE_API_KEY" -H "Accept: application/json" "https://api.search.brave.com/res/v1/web/search?q=test"

   :: Same request, explicitly through the proxy iHub is configured to use
   curl -sS -v --connect-timeout 10 --max-time 20 -x "http://your-proxy:8080" -H "X-Subscription-Token: YOUR_BRAVE_API_KEY" -H "Accept: application/json" "https://api.search.brave.com/res/v1/web/search?q=test"

   :: Best fidelity: run the request through iHub's own code and print the result
   set BRAVE_SEARCH_API_KEY=YOUR_BRAVE_API_KEY && set HTTPS_PROXY=http://your-proxy:8080 && node --input-type=module -e "import braveSearch from './server/tools/braveSearch.js'; const result = await braveSearch({ query: 'test', maxResults: 3 }); console.log(JSON.stringify(result, null, 2));"
   ```

   Compare the two runs:
   - Direct succeeds fast, proxied hangs or times out → the proxy (or its domain allow-list) is the problem.
   - Both hang → not the proxy; check firewall/DNS/egress rules from that host instead.
   - Both succeed → the proxy itself is fine; check for config drift on the affected host — `proxy.noProxy` or `proxy.urlPatterns` in `platform.json` can exclude one domain (e.g. Brave's) while everything else is proxied correctly.

3. **Check proxy allows HTTPS:**
   - Most proxies need CONNECT method support for HTTPS
   - Some corporate proxies block AI API domains

4. **Check credentials:**
   - If proxy requires authentication, ensure username:password is correct
   - Try URL encoding special characters in password

5. **Test without SSL verification (dev only):**
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
- ✅ Web search APIs (Brave)
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
