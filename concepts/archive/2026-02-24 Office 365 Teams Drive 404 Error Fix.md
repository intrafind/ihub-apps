# Office 365 Teams Drive 404 Error - Root Cause and Fix

**Date:** 2026-02-24  
**Issue:** All Teams drives returning 404 after admin rights removal  
**Status:** Fixed

## Problem Statement

After the admin rights removal change (2026-02-20), all Teams drives were showing as empty. Logs showed that all Teams were being found (22 teams), but every single one returned a 404 error when trying to access their drives.

```
{"message":"👥 Loading 22 Microsoft Teams drives..."}
{"message":"Team 9bfd5c49-1e86-498b-bc31-43dfb8a868db has no SharePoint site (404), skipping"}
[... 21 more teams with 404 errors ...]
{"message":"✅ Batch processing complete - 0 team drives retrieved"}
```

## Root Cause

The admin rights removal change (documented in `concepts/2026-02-20 Office 365 Admin Rights Removal.md`) incorrectly changed the endpoint from `/groups/{id}/drive` to `/teams/{id}/drive`.

**The critical issue:** `/teams/{id}/drive` is **NOT a valid Microsoft Graph API endpoint**. This endpoint does not exist in the Microsoft Graph API documentation.

### Why the Change Was Made

The original change was attempting to avoid needing `Group.Read.All` permission by using what was thought to be a Teams-specific endpoint. However, this was based on a misunderstanding of the Microsoft Graph API structure.

### The Correct API Structure

According to Microsoft's documentation:

1. **Teams are backed by Microsoft 365 Groups**
   - Every Team has an associated Microsoft 365 Group
   - The Team ID and Group ID are the same

2. **Accessing Team Files**
   - Files for a Team are stored in the associated Group's SharePoint document library
   - The correct endpoint is: `/groups/{id}/drive`
   - There is NO `/teams/{id}/drive` endpoint

3. **Permissions Required**
   - `Files.Read.All` - Read all files user can access
   - `Sites.Read.All` - Read items in all site collections
   - `Team.ReadBasic.All` - Read basic team information (for `/me/joinedTeams`)
   - **Does NOT require** `Group.Read.All` to access `/groups/{id}/drive`

## The Misconception

The admin rights removal change assumed:
- Using `/groups/` endpoint requires `Group.Read.All` permission
- Using `/teams/` endpoint only requires Teams permissions

**The reality:**
- `/groups/{id}/drive` works with `Files.Read.All` and `Sites.Read.All` (no `Group.Read.All` needed)
- `/teams/{id}/drive` doesn't exist at all in the API

## Solution

Reverted the endpoint change back to `/groups/{id}/drive`:

```javascript
// INCORRECT - This endpoint does not exist
url: `/teams/${team.id}/drive`

// CORRECT - This is the proper endpoint
url: `/groups/${team.id}/drive`
```

### Code Changes

**File:** `server/services/integrations/Office365Service.js` (line ~667)

```javascript
// Create batch requests
// Note: Use /groups/ endpoint because Teams are backed by Microsoft 365 Groups
// The /teams/{id}/drive endpoint does not exist in Microsoft Graph API
const requests = teamsBatch.map(team => ({
  id: team.id,
  method: 'GET',
  url: `/groups/${team.id}/drive`  // ← Fixed: was /teams/${team.id}/drive
}));
```

## Verification

After this fix:
- Teams drives should load correctly
- No admin consent required (still using same permissions)
- All existing Teams with SharePoint sites will show their drives

## Key Learnings

1. **Verify API Endpoints**: Always check official Microsoft Graph documentation before changing endpoints
2. **Permission Model**: Using `/groups/{id}/drive` does NOT require `Group.Read.All` permission when:
   - Using delegated permissions (user context)
   - User has access to the files through `Files.Read.All` and `Sites.Read.All`
   - The Group ID is obtained from `/me/joinedTeams` (respects user membership)

3. **Teams = Groups**: In Microsoft Graph API, Teams are built on top of Microsoft 365 Groups
   - Team ID = Group ID
   - Team files = Group's SharePoint site
   - Use `/groups/` endpoints to access Team resources

## References

- [Microsoft Graph: Get drive](https://learn.microsoft.com/en-us/graph/api/drive-get?view=graph-rest-1.0)
- [Working with files in Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/resources/onedrive?view=graph-rest-1.0)
- [Teams API Overview](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview?view=graph-rest-1.0)

## Related Files

- `server/services/integrations/Office365Service.js` - Fixed endpoint
- `concepts/2026-02-20 Office 365 Admin Rights Removal.md` - Original (incorrect) change
- `concepts/2026-02-24 Office 365 Teams Drive Empty After Admin Rights Removal Fix.md` - Token migration (not the root cause)
