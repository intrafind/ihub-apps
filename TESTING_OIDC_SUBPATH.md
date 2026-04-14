# Testing OIDC Authentication with Subpath Deployment

This document explains how to test the OIDC authentication fix for subpath deployments.

## Issue Background

When iHub Apps is deployed under a subdirectory (e.g., `https://mydomain/ihub`), OIDC authentication would redirect users to the wrong URL after successful authentication. Instead of redirecting to `/ihub/`, it would redirect to `/`, which could be a different application.

## The Fix

The fix modifies `server/middleware/oidcAuth.js` to:
1. Use `buildServerPath()` utility to dynamically include base path from `X-Forwarded-Prefix` header
2. Construct callback URLs that respect the deployment subpath
3. Ensure all redirect URLs include the base path

## Testing Scenarios

### Scenario 1: Root Deployment (No Subpath)

**Setup:**
- Deploy iHub Apps at `https://mydomain/` (root)
- Configure OIDC provider (e.g., ADFS)
- No `X-Forwarded-Prefix` header set

**Expected Behavior:**
1. Click OIDC login button
2. User redirects to `https://adfs-provider/authorize?...&redirect_uri=https://mydomain/api/auth/oidc/adfs/callback`
3. After authentication, ADFS redirects back to `https://mydomain/api/auth/oidc/adfs/callback`
4. Server processes authentication and redirects to `https://mydomain/`

**URLs to verify:**
- Callback URL in OIDC provider config: `https://mydomain/api/auth/oidc/adfs/callback`
- Final redirect after authentication: `https://mydomain/`

### Scenario 2: Subpath Deployment (e.g., /ihub)

**Setup:**
- Deploy iHub Apps at `https://mydomain/ihub/`
- Configure nginx to set `X-Forwarded-Prefix: /ihub` header
- Configure OIDC provider (e.g., ADFS)

**Expected Behavior:**
1. Click OIDC login button
2. User redirects to `https://adfs-provider/authorize?...&redirect_uri=https://mydomain/ihub/api/auth/oidc/adfs/callback`
3. After authentication, ADFS redirects back to `https://mydomain/ihub/api/auth/oidc/adfs/callback`
4. Server processes authentication and redirects to `https://mydomain/ihub/`

**URLs to verify:**
- Callback URL in OIDC provider config: `https://mydomain/ihub/api/auth/oidc/adfs/callback`
- Final redirect after authentication: `https://mydomain/ihub/`

### Scenario 3: Subpath with Custom Return URL

**Setup:**
- Same as Scenario 2
- User initiates login from a specific page (e.g., `/ihub/apps/chat`)

**Expected Behavior:**
1. Click OIDC login button from `/ihub/apps/chat`
2. User redirects to ADFS provider
3. After authentication, redirects back to callback URL
4. Server processes authentication and redirects to `/ihub/apps/chat` (or default if no return URL saved)

## Nginx Configuration Example

```nginx
location /ihub/ {
    proxy_pass http://backend:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /ihub;  # CRITICAL: Set base path
}
```

## Manual Testing Steps

1. **Deploy with subpath:**
   ```bash
   # Set up nginx with X-Forwarded-Prefix header
   # Start iHub Apps backend on port 3000
   ```

2. **Configure OIDC provider in Admin UI:**
   - Go to `/ihub/admin/auth`
   - Enable OIDC authentication
   - Configure provider details (ADFS, Azure AD, etc.)
   - Note the callback URL shown in the UI

3. **Test authentication flow:**
   - Open browser to `https://mydomain/ihub/`
   - Click "Login with OIDC" button
   - Verify redirect to OIDC provider includes correct callback URL
   - Complete authentication on OIDC provider
   - Verify redirect back to `https://mydomain/ihub/` (not `https://mydomain/`)

4. **Check browser developer tools:**
   - Network tab: Verify redirect URLs include `/ihub` prefix
   - Console: Check for any 404 errors or incorrect paths

## Debugging

If authentication fails:

1. **Check callback URL in OIDC provider configuration:**
   - Should be `https://mydomain/ihub/api/auth/oidc/{provider}/callback`
   - NOT `https://mydomain/api/auth/oidc/{provider}/callback`

2. **Verify X-Forwarded-Prefix header:**
   ```bash
   # Check nginx is setting the header correctly
   curl -I https://mydomain/ihub/ | grep -i x-forwarded-prefix
   ```

3. **Check server logs:**
   ```bash
   npm run logs
   # Look for OIDC authentication logs showing callback URL
   ```

4. **Enable debug logging:**
   - Set `LOG_LEVEL=debug` in `.env`
   - Check logs for base path detection

## Expected Log Output

With the fix, you should see logs like:

```json
{
  "component": "OidcAuth",
  "level": "info",
  "message": "OIDC provider configured",
  "providerName": "adfs"
}
```

And when authentication completes:

```json
{
  "component": "OidcAuth",
  "level": "info",
  "message": "auth_flow_complete_redirect",
  "provider": "adfs",
  "userId": "user@domain.com",
  "finalRedirectUrl": "/ihub/?token=***&provider=adfs"
}
```

Note the `/ihub/` prefix in the finalRedirectUrl.

## Known Limitations

1. If the OIDC provider configuration has a hardcoded `callbackURL` field, it will override the automatic base path detection
2. The fix relies on the reverse proxy setting the `X-Forwarded-Prefix` header correctly
3. Some OIDC providers may need the callback URL to be registered explicitly - make sure to use the full URL with the subpath

## Related Files

- `server/middleware/oidcAuth.js` - OIDC authentication handler
- `server/utils/basePath.js` - Base path detection utilities
- `server/routes/auth.js` - Authentication routes
- `client/src/utils/runtimeBasePath.js` - Client-side base path detection
