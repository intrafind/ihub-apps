# Office 365 Drive Listing - Debugging & Performance

**Date:** 2026-02-17
**Issue:** Drive listing request hangs (wheel keeps spinning)

## Changes Made

### 1. Added Comprehensive Logging

Added detailed logging throughout the drive listing process to track progress:

**Start of Process:**
```
🔍 Starting drive listing for user
Drive sources configuration: { personalDrive: true, followedSites: true, teams: true }
```

**Each Section:**
```
📁 Loading personal OneDrive drives...
✅ Loaded 2 personal drives

🌐 Loading followed SharePoint sites...
📋 Found 5 followed sites

👥 Loading Microsoft Teams drives...
📊 Processing 12 joined Teams...
✅ Loaded 8 Teams drives

✅ Drive listing complete - Total: 15 drives
```

This logging will help identify which section is slow or hanging.

### 2. Added 60-Second Timeout

Added a timeout to prevent the request from hanging forever:

**File:** `server/routes/integrations/office365.js`

```javascript
// Add 60 second timeout to prevent hanging
const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('Drive listing timed out after 60 seconds')), 60000)
);

const drives = await Promise.race([
  Office365Service.listDrives(req.user.id),
  timeoutPromise
]);
```

If the drive listing takes more than 60 seconds, the request will fail with a clear error message instead of hanging indefinitely.

### 3. Improved 404 Error Handling

Changed 404 errors to log at DEBUG level instead of ERROR (already done):

```javascript
// Log 404 errors as debug (expected for Teams without SharePoint sites, etc.)
if (error.response?.status === 404) {
  logger.debug('Office 365 API returned 404 (not found):', {
    component: 'Office 365',
    endpoint,
    error: error.response?.data?.error?.message || 'Resource not found'
  });
}
```

## What to Look For in Logs

When you try again, check the logs for:

1. **"🔍 Starting drive listing"** - Request started
2. **"📁 Loading personal OneDrive drives..."** - Check if this completes
3. **"🌐 Loading followed SharePoint sites..."** - Check if this completes
4. **"👥 Loading Microsoft Teams drives..."** - Check if this hangs here
5. **"✅ Drive listing complete"** - Request succeeded

If the logs stop at a particular step, that's where the issue is.

## Common Issues

### Teams Processing Is Slow

If you have many Teams (10+), the process can be slow because it:
1. Gets all joined Teams
2. For each Team, gets all channels
3. For each channel, tries to get the files folder

**Example:** 10 Teams × 5 channels = 50 API calls

### Solution: Disable Teams Source Temporarily

If Teams is causing issues, you can disable it in the provider configuration:

```json
{
  "sources": {
    "personalDrive": true,
    "followedSites": true,
    "teams": false  // ← Disable Teams
  }
}
```

This will skip Teams processing and only show OneDrive and SharePoint sites.

### Followed Sites Returning 404

Some followed sites may not have accessible drives (404 errors). This is expected and handled gracefully:

```
{"level":"warn","message":"Could not load drives for site Daniel Upload Test:","error":"Office 365 API error: Requested site could not be found"}
```

The code continues processing other sites.

## Timeout Behavior

If the request times out after 60 seconds, you'll see:

```
❌ Error listing Office 365 drives: Drive listing timed out after 60 seconds
```

**Frontend Response:**
```json
{
  "error": "Failed to list drives",
  "message": "Drive listing timed out after 60 seconds"
}
```

The user will see an error message instead of an infinite spinner.

## Next Steps

1. **Try the request again** - Check the new detailed logs
2. **Identify which section is slow** - OneDrive, SharePoint sites, or Teams
3. **Consider disabling slow sections** - Temporarily disable Teams if it's the bottleneck
4. **Optimize if needed** - We can implement parallel processing or caching if one section is consistently slow

## Performance Improvements (Future)

If the issue persists, we can:

1. **Implement parallel processing** - Fetch Teams channels in parallel
2. **Add caching** - Cache drive lists for 5-10 minutes
3. **Lazy loading** - Load drives on-demand instead of all at once
4. **Pagination** - Return drives in pages instead of all at once
5. **Background job** - Fetch drives in background, show cached results immediately
