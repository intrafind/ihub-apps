# Manual Testing Guide for SSO Flow Optimization

This guide helps verify the SSO flow performance improvements.

## Prerequisites

1. Have an OIDC provider configured (e.g., Microsoft Entra, Google, Auth0)
2. Enable OIDC authentication in `contents/config/platform.json`:
   ```json
   {
     "oidcAuth": {
       "enabled": true,
       "providers": [
         {
           "name": "your-provider",
           "enabled": true,
           "autoRedirect": false,
           "clientId": "...",
           "clientSecret": "...",
           "authorizationURL": "...",
           "tokenURL": "...",
           "userInfoURL": "..."
         }
       ]
     }
   }
   ```
3. Build and run the application:
   ```bash
   npm run install:all
   npm run dev
   ```

## Test Scenarios

### Test 1: OIDC Callback with Early Token Detection

**Objective:** Verify that token is detected and stored before React loads

**Steps:**
1. Navigate to `http://localhost:5173`
2. Click "Sign in with [Provider]" button
3. Complete authentication on the provider's login page
4. You will be redirected back to `http://localhost:5173/?token=...&provider=...`
5. **Open browser console immediately** (F12)

**Expected Results:**
- Console should show: `🚀 Early token detection: OIDC callback from [provider]`
- Console should show: `✅ Token stored, URL cleaned - React will use cached token`
- URL bar should change from `/?token=...&provider=...` to `/` almost immediately
- Console should show: `⚡ Using fast-tracked OIDC token from early detection`
- Console should show: `⚡ Fast-tracked OIDC callback: Token already stored`
- Authentication should complete in **under 1 second** (vs 2-4 seconds before)

**Verify:**
- Open Application tab in DevTools
- Check localStorage: `authToken` should be present
- Check sessionStorage: `oidcCallbackFastTrack` should be removed after processing
- Browser history: pressing back should NOT expose the token in URL

### Test 2: OIDC Auto-Redirect

**Objective:** Verify auto-redirect still works with optimization

**Steps:**
1. Configure one OIDC provider with `autoRedirect: true` in platform.json
2. Disable all other auth methods (local, proxy, anonymous)
3. Clear localStorage and sessionStorage
4. Navigate to `http://localhost:5173`

**Expected Results:**
- Should auto-redirect to OIDC provider immediately
- After authentication, should return and use fast-track flow
- Console logs should show early detection and fast-track messages

### Test 3: Fallback to Normal Flow

**Objective:** Verify graceful degradation if early detection fails

**Steps:**
1. Modify `client/index.html` to intentionally break early detection (e.g., throw error)
2. Complete OIDC login flow

**Expected Results:**
- App should still authenticate successfully using normal flow
- Console should show warning: `Early token detection failed: [error]`
- Authentication completes via normal React flow (takes 2-4 seconds)
- No app crashes or errors

### Test 4: Non-OIDC Authentication Methods

**Objective:** Verify other auth methods are not affected

**Steps:**
1. Test local authentication (username/password)
2. Test proxy authentication (if configured)
3. Test anonymous access (if enabled)

**Expected Results:**
- All other auth methods work as before
- No console errors related to OIDC fast-track
- Early detection script doesn't interfere

### Test 5: Browser Compatibility

**Objective:** Verify early detection works across browsers

**Browsers to Test:**
- Chrome/Edge (Chromium)
- Firefox
- Safari (if available)

**Steps:**
1. Complete OIDC login in each browser
2. Check console for early detection logs

**Expected Results:**
- All browsers show early detection logs
- Authentication is fast in all browsers
- No browser-specific errors

## Performance Measurement

### Before Optimization
1. Clear browser cache and localStorage
2. Open DevTools Network tab
3. Start recording
4. Complete OIDC login flow
5. Measure time from redirect to authenticated state
   - **Expected:** 2-4 seconds

### After Optimization
1. Clear browser cache and localStorage
2. Open DevTools Network tab
3. Start recording
4. Complete OIDC login flow
5. Measure time from redirect to authenticated state
   - **Expected:** 0.5-1 second

### Key Metrics to Track
- Time to token storage (should be < 100ms with early detection)
- Time to URL cleanup (should be < 100ms with early detection)
- Time to authentication complete (should be < 1 second total)
- Number of API calls (should be reduced)

## Debug Console Logs

### Successful Fast-Track Flow
```
🚀 Early token detection: OIDC callback from google
✅ Token stored, URL cleaned - React will use cached token
⚡ Using fast-tracked OIDC token from early detection
⚡ Fast-tracked OIDC callback: Token already stored
↩️ Redirecting to stored return URL after token login: /apps/chat
```

### Normal Flow (Fallback)
```
Early token detection failed: [error]
🔍 OIDC Callback: Processing login token
↩️ Redirecting to stored return URL after token login: /apps/chat
```

### Auto-Redirect Flow
```
🔀 Auto-redirecting to google provider
[... redirect to provider ...]
🚀 Early token detection: OIDC callback from google
✅ Token stored, URL cleaned - React will use cached token
⚡ Fast-tracked OIDC callback: Token already stored
```

## Common Issues

### Token Not Detected Early
- **Symptom:** No "🚀 Early token detection" log
- **Cause:** Early detection script not running
- **Fix:** Check index.html script placement, ensure JavaScript is enabled

### Fast-Track Flag Not Cleared
- **Symptom:** sessionStorage.oidcCallbackFastTrack persists
- **Cause:** Error in handleOidcCallback
- **Fix:** Check for JavaScript errors, clear sessionStorage manually

### URL Not Cleaned
- **Symptom:** Token remains in URL after redirect
- **Cause:** history.replaceState failed
- **Fix:** Check browser compatibility, ensure script executes

## Security Verification

### Token Exposure
1. Complete OIDC login
2. Check browser history (back button)
3. Token should NOT appear in any history entry

### localStorage Security
1. Token should be stored in localStorage (same as before)
2. Token should be removed on logout
3. Token should expire based on JWT expiration

### sessionStorage Cleanup
1. Fast-track flag should be removed after use
2. No sensitive data should remain in sessionStorage

## Success Criteria

✅ Early token detection logs appear in console  
✅ Token stored before React loads  
✅ URL cleaned immediately (no token in history)  
✅ Authentication completes in < 1 second  
✅ Fast-track flag is set and cleared properly  
✅ Fallback to normal flow works if early detection fails  
✅ Other auth methods not affected  
✅ No security regressions  
✅ No console errors or warnings  
✅ Works across major browsers  

## Rollback Plan

If issues are found:
1. Revert `client/index.html` changes (remove early detection script)
2. Revert `client/src/shared/contexts/AuthContext.jsx` changes (remove fast-track logic)
3. Rebuild and redeploy
4. Normal authentication flow will resume

The changes are designed to gracefully degrade, so reverting is straightforward.
