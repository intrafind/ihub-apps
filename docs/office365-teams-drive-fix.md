# Teams Drive Loading Issue - Fix Summary

## Problem
After removing the `Group.Read.All` permission (to eliminate admin consent requirements), existing Office 365 users found that their Teams drive list was showing empty, even though they were members of Teams.

## Root Cause
When the OAuth scopes were changed to remove `Group.Read.All`, existing users' access tokens were still bound to the old permission combination. Microsoft OAuth tokens are tied to the exact scope set granted during authorization, so changing the requested scopes doesn't automatically update existing tokens. This caused `/me/joinedTeams` to return empty results for users with old tokens.

## Solution
Implemented automatic detection and migration of old tokens:

1. **Automatic Detection**: The system now checks if stored tokens contain `Group.Read.All` in their scope
2. **Automatic Cleanup**: Old tokens are automatically deleted when detected
3. **Clear Messaging**: Users receive a clear error message: "Office 365 permissions have been updated. Please reconnect your account to continue accessing Teams drives."
4. **One-Time Action**: Users only need to reconnect once

## What Happens Now

### For Existing Users with Old Tokens
1. **Next Teams Access**: When they try to access Teams drives, they'll see a message to reconnect
2. **Reconnect**: They click "Connect Office 365 Account" button in Settings → Integrations
3. **OAuth Flow**: They go through the standard OAuth consent (no admin approval needed)
4. **Success**: After reconnecting, Teams drives load correctly with the new permission set

### For New Users or Already Migrated Users
- No impact - everything works normally
- Teams drives load immediately after connecting

## Files Changed
- `server/services/integrations/Office365Service.js` - Added old token detection logic
- `server/tests/office365-old-token-migration.test.js` - Test suite for token migration
- `concepts/2026-02-24 Office 365 Teams Drive Empty After Admin Rights Removal Fix.md` - Detailed concept document
- `docs/office365-admin-consent-removal.md` - Updated user documentation

## How to Verify the Fix

### Manual Testing (Recommended)
1. **Simulate old token** (for testing):
   - You would need access to a user with a token that still has `Group.Read.All`
   - Or manually modify a token in the token storage to include `Group.Read.All` in the scope

2. **Test the flow**:
   - Navigate to Settings → Integrations
   - Try to access Teams drives (if you have an old token)
   - You should see: "Office 365 permissions have been updated. Please reconnect your account."
   - Click "Connect Office 365 Account"
   - Complete the OAuth flow
   - Verify Teams drives now load correctly

### Automated Testing
```bash
# Run the token migration test
node server/tests/office365-old-token-migration.test.js
```

Expected output:
```
🧪 Testing old token detection...

Test 1: Old token with Group.Read.All
  ✅ PASSED: Old token detected and error thrown
  ✅ PASSED: Delete called 1 time(s)

Test 2: New token without Group.Read.All
  ✅ PASSED: New token passed through correctly

Test 3: Token without scope field
  ✅ PASSED: Token without scope field passed through

Test 4: Old token with Group.Read.All at start of scope
  ✅ PASSED: Detected Group.Read.All at different position

✨ All tests completed!
```

## Logging
When old tokens are detected, you'll see log entries like:
```json
{
  "level": "warn",
  "message": "⚠️ Detected old Office 365 token with Group.Read.All scope for user abc123. Invalidating tokens to force re-authentication with new scopes.",
  "component": "Office 365",
  "oldScope": "User.Read Files.Read.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All Group.Read.All offline_access"
}
```

## User Communication (Optional)
Consider sending an email to users who have Office 365 connected, explaining:
- Permissions have been updated to remove admin consent requirement
- They may need to reconnect their Office 365 account (one-time action)
- The process takes less than a minute
- After reconnecting, all features will work as before

## Support
If users encounter issues:
1. Verify they can see the integration page and the "Connect" button
2. Check server logs for the old token detection warning
3. Ensure the OAuth callback URL is configured correctly
4. Confirm the Azure AD app has the updated permissions

## Related Documentation
- [Concept Document](../concepts/2026-02-24%20Office%20365%20Teams%20Drive%20Empty%20After%20Admin%20Rights%20Removal%20Fix.md) - Detailed technical explanation
- [User Documentation](./office365-admin-consent-removal.md) - User-facing documentation with migration notes
- [Admin Rights Removal](../concepts/2026-02-20%20Office%20365%20Admin%20Rights%20Removal.md) - Original change that required this fix
