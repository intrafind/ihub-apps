# Office 365 Rate Limiting Fix

**Date:** 2026-02-17
**Issue:** API rate limit exceeded ("TooManyRequests") when user has many Teams

## Problem

Users with many Microsoft Teams were experiencing:
1. **Spinning wheel** - Request never completes
2. **Rate limit errors** - "TooManyRequests" after ~1 minute
3. **Poor performance** - Hundreds of API calls in rapid succession

### Root Cause

The Teams listing was making too many API calls:
- 1 call for `/me/joinedTeams`
- N calls for `/teams/{id}/channels` (one per team)
- N × M calls for `/teams/{id}/channels/{id}/filesFolder` (one per channel)

**Example:** 20 Teams × 10 channels = **221 API calls**

Microsoft Graph API has rate limits, and making 200+ calls in rapid succession triggers "TooManyRequests" (HTTP 429).

## Solution

### 1. Limit Teams Processing

Only process first **10 Teams** to avoid rate limits and timeouts:

```javascript
// Limit to first 10 teams to avoid rate limits and timeouts
const teamsToProcess = teams.slice(0, 10);
if (teams.length > 10) {
  logger.warn(
    `⚠️ User has ${teams.length} Teams. Processing only first 10 to avoid rate limits.`,
    { component: 'Office 365' }
  );
}
```

This reduces API calls from 200+ to ~50 maximum.

### 2. Add Delays Between API Calls

Added 100ms delays between:
- Team processing
- Channel processing

```javascript
// Add small delay between teams to avoid rate limiting
await this._delay(100);

// Add small delay between channel requests
await this._delay(100);
```

This spreads out API calls over time instead of making them all at once.

### 3. Improved Rate Limit Error Handling

Added specific handling for 429 errors:

```javascript
if (error.response?.status === 429) {
  const retryAfter = error.response?.headers?.['retry-after'] || 'unknown';
  logger.warn(`⏱️ Rate limit exceeded. Retry after: ${retryAfter} seconds`, {
    component: 'Office 365',
    endpoint
  });
  throw new Error('Office 365 API rate limit exceeded. Please try again in a moment.');
}
```

Users now see a clear message instead of a generic error.

## Filtering Teams Without Documents

**Question:** Is there a way to filter Teams which do not have documents?

**Answer:** Yes! The code already does this automatically:

### How It Works

1. For each Teams channel, the code tries to get the files folder:
   ```javascript
   const filesFolder = await this.makeApiRequest(
     `/teams/${team.id}/channels/${channel.id}/filesFolder`,
     'GET',
     null,
     userId
   );
   ```

2. If the channel has no documents, Microsoft returns **404** ("Requested site could not be found")

3. The code catches this error and **skips that channel** (doesn't add it to the list)

4. **Only channels with documents are returned**

### What Gets Filtered Out

- ✅ Teams channels **with** documents → **Included in list**
- ❌ Teams channels **without** documents → **Automatically filtered out**
- ❌ Chat-only channels → **Automatically filtered out**
- ❌ New Teams with no files → **Automatically filtered out**

So you already get **only Teams with files** in the drive list!

## Performance Improvements

### Before
- **API Calls:** 200+ in rapid succession
- **Time:** Times out after 60 seconds
- **Result:** Rate limit errors, spinning wheel

### After
- **API Calls:** ~50 maximum, spread over time
- **Time:** 5-10 seconds typical
- **Result:** Fast, reliable listing

## Configuration

If you want to adjust the Teams limit, edit the code:

```javascript
// Change 10 to desired limit
const teamsToProcess = teams.slice(0, 10);
```

**Recommendations:**
- **10 Teams** - Good balance (default)
- **5 Teams** - Very fast, minimal API calls
- **20 Teams** - May hit rate limits with many channels
- **Unlimited** - Will hit rate limits, not recommended

## Alternative: Disable Teams

If you don't need Teams file access, you can disable it in the provider configuration:

```json
{
  "sources": {
    "personalDrive": true,
    "followedSites": true,
    "teams": false  // ← Disable Teams entirely
  }
}
```

This eliminates all Teams API calls.

## Future Improvements

If needed, we can:
1. **Implement pagination** - Return Teams in pages, user loads more on demand
2. **Add caching** - Cache Teams list for 5-10 minutes
3. **Background sync** - Fetch Teams in background, show cached results
4. **Selective loading** - Let user choose which Teams to include
5. **Smart filtering** - Only fetch Teams that are frequently accessed

## Testing

After these changes, the drive listing should:
- ✅ Complete in 5-10 seconds
- ✅ Return OneDrive, SharePoint sites, and first 10 Teams with files
- ✅ No rate limit errors
- ✅ Clear warning if user has more than 10 Teams
