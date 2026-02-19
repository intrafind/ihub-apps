# Office 365 "Site Not Found" Errors - Explained

**Date:** 2026-02-17
**Status:** ✅ Fixed (reduced logging noise)

## What Was Happening

When listing Teams drives, you were seeing error messages like:

```
Office 365 API request failed: Requested site could not be found
```

This looked alarming, but the functionality was **actually working correctly**. Here's why:

## Root Cause

### Expected Behavior

Not all Microsoft Teams channels have an associated SharePoint site or files folder:

1. **Some Teams are new** and haven't had any files uploaded yet
2. **Some channels are chat-only** and don't have document libraries
3. **Some Teams have restricted SharePoint site access** separate from Teams access

When the code tries to access the files folder for these channels via:
```javascript
/teams/${team.id}/channels/${channel.id}/filesFolder
```

Microsoft Graph API returns a **404 "Requested site could not be found"** error.

### The Problem

The `makeApiRequest` function was logging ALL errors at ERROR level, even expected 404s that are handled gracefully. This made the logs look like something was broken when it was actually working fine.

## How It Was Being Handled

The code **already had proper error handling**:

```javascript
// From listTeamsDrives function
for (const channel of channels) {
  try {
    const filesFolder = await this.makeApiRequest(
      `/teams/${team.id}/channels/${channel.id}/filesFolder`,
      'GET',
      null,
      userId
    );
    // ... use filesFolder
  } catch (e) {
    // ✅ Error is caught here and logged as WARNING
    logger.warn(`Could not load files folder for channel ${channel.displayName}:`, {
      error: e.message
    });
    // Continue to next channel instead of failing
  }
}
```

The function:
1. Tries to get the files folder for each channel
2. If it fails (404), catches the error
3. Logs a warning (not an error)
4. Continues to the next channel
5. Returns the channels that DO have files folders

## The Fix

Changed the error logging in `makeApiRequest` to be smarter about 404 errors:

**Before:**
```javascript
logger.error('❌ Office 365 API request failed:', {
  component: 'Office 365',
  error: error.response?.data || error.message
});
```

**After:**
```javascript
// Log 404 errors as debug (expected for Teams without SharePoint sites, etc.)
if (error.response?.status === 404) {
  logger.debug('Office 365 API returned 404 (not found):', {
    component: 'Office 365',
    endpoint,
    error: error.response?.data?.error?.message || 'Resource not found'
  });
  throw new Error(
    `Office 365 API error: ${error.response?.data?.error?.message || error.message}`
  );
}

// Log other errors as error
logger.error('❌ Office 365 API request failed:', {
  component: 'Office 365',
  error: error.response?.data || error.message
});
```

Now:
- **404 errors** (expected) are logged at **DEBUG** level
- **Other errors** (unexpected) are still logged at **ERROR** level
- The functionality remains exactly the same

## Result

Your Office 365 integration will now:
- ✅ Still list all Teams drives that have SharePoint sites
- ✅ Gracefully skip Teams/channels without sites
- ✅ Have cleaner logs without scary-looking 404 errors
- ✅ Still report real errors at ERROR level

## Verification

After the fix, when you list drives you should see:
- Your personal OneDrive ✅
- Followed SharePoint sites ✅
- Teams with files ✅
- **NO error logs** for Teams without files (logged at debug instead)

The drive list will only include Teams that actually have files/SharePoint sites, which is the correct behavior.
