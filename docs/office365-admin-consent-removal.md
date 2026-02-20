# Office 365 Integration - Admin Consent Removal

**Date:** 2026-02-20  
**Issue:** Office 365 integration required admin consent, blocking regular users

## Problem

The Office 365 integration was requesting the `Group.Read.All` permission, which requires admin consent in Microsoft Azure AD. This meant that regular users could not connect their Office 365 accounts without administrator approval, significantly limiting adoption and usability.

## Root Cause

The integration was using the `/groups/{team-id}/drive` endpoint to access Microsoft Teams drives. While this endpoint works, accessing group resources via the `/groups/` API requires the `Group.Read.All` permission, which is classified as requiring admin consent by Microsoft.

## Solution

Changed the implementation to use the `/teams/{team-id}/drive` endpoint instead of `/groups/{team-id}/drive`. This endpoint provides the same functionality but only requires the `Files.Read.All` and `Sites.Read.All` permissions, which can be granted by users themselves without admin approval.

### Code Changes

**File:** `server/services/integrations/Office365Service.js`

1. **Removed `Group.Read.All` from OAuth scopes** (lines 116-124):
```javascript
// OLD - Required admin consent
const scopes = [
  'User.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'Group.Read.All',  // ❌ REMOVED - Requires admin consent
  'offline_access'
].join(' ');

// NEW - User consent only
const scopes = [
  'User.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'offline_access'
].join(' ');
```

2. **Changed endpoint from `/groups/` to `/teams/`** (line 642):
```javascript
// OLD - Requires Group.Read.All
url: `/groups/${team.id}/drive`

// NEW - Works with existing permissions
url: `/teams/${team.id}/drive`
```

3. **Updated refresh token scope** (line 241):
```javascript
// OLD
scope: 'User.Read Files.Read.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All Group.Read.All offline_access'

// NEW
scope: 'User.Read Files.Read.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All offline_access'
```

## Current Permissions

After this change, the Office 365 integration requires these delegated permissions (all support user consent):

| Permission | Type | Admin Consent Required? | Description |
|------------|------|------------------------|-------------|
| User.Read | Delegated | **No** ✅ | Read user profile |
| Files.Read.All | Delegated | **No** ✅ | Read all files user can access |
| Sites.Read.All | Delegated | **No** ✅ | Read items in all site collections |
| Team.ReadBasic.All | Delegated | **No** ✅ | Read basic team information |
| Channel.ReadBasic.All | Delegated | **No** ✅ | Read basic channel information |
| offline_access | Delegated | **No** ✅ | Maintain access to data (refresh token) |

## Impact

### ✅ Benefits

- **No admin approval needed**: Regular users can connect their Office 365 accounts immediately
- **Improved user experience**: Eliminates the admin consent bottleneck
- **Faster adoption**: Users can start using the integration right away
- **Same functionality**: All features (OneDrive, SharePoint, Teams) work identically
- **Better security**: Follows principle of least privilege

### ⚠️ Migration Notes

**For existing connected users:**
- Existing connections will continue to work
- The old `Group.Read.All` permission will remain granted until users disconnect and reconnect
- Users do not need to take any action unless they want to reduce their granted permissions

**For new connections:**
- Users will only be prompted for the new, reduced set of permissions
- No admin approval required in any scenario

## Azure AD App Configuration

No changes needed to existing Azure AD app registrations. The app registration should have these permissions configured:

1. Go to **Azure Portal** → **App registrations**
2. Select your app
3. Go to **API permissions**
4. Ensure these Microsoft Graph delegated permissions are present:
   - User.Read
   - Files.Read.All
   - Sites.Read.All
   - Team.ReadBasic.All
   - Channel.ReadBasic.All
   - offline_access

**Note:** You can optionally remove `Group.Read.All` from the app registration if it's no longer needed for other purposes.

## Testing

After this change:

1. Navigate to **Settings → Integrations**
2. Click **Connect Office 365 Account**
3. Verify that the Microsoft consent screen appears
4. Confirm that you can grant consent without admin approval
5. Complete the OAuth flow
6. Test file browsing from:
   - Personal OneDrive
   - SharePoint sites
   - Teams channels

## Technical Details

### Why `/teams/{id}/drive` Works Better

Microsoft Graph provides two equivalent ways to access a Team's document library:

1. **Via Groups API**: `/groups/{id}/drive`
   - Requires: `Group.Read.All` (admin consent needed)
   - Reason: Groups API grants broad access to organizational groups

2. **Via Teams API**: `/teams/{id}/drive` ✅
   - Requires: `Files.Read.All` or `Sites.Read.All` (user consent only)
   - Reason: Teams API is scoped to user's accessible teams only

Both endpoints return the same Drive resource, but the Teams endpoint respects the user's existing team memberships and doesn't require additional group read permissions.

### User Context

With delegated permissions, the API only returns teams that the signed-in user is a member of. The user cannot access teams they don't belong to, regardless of which endpoint is used.

## References

- [Microsoft Graph: Get team drive](https://learn.microsoft.com/en-us/graph/api/drive-get?view=graph-rest-1.0)
- [Microsoft Graph: Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Best practices for Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/best-practices-graph-permission)
- [Understanding delegated permissions vs application permissions](https://learn.microsoft.com/en-us/graph/auth/auth-concepts)

## Related Changes

This change supersedes the previous scope update documented in `office365-scope-update.md` which added `Group.Read.All`. That permission has now been removed in favor of a more user-friendly approach.
