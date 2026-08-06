# Outlook Integration File Upload Fix

**Date:** 2026-04-22
**Issue:** File Upload does not work with Outlook integration
**Branch:** `claude/fix-file-upload-outlook-integration`

## Problem Statement

The Outlook integration did not support combining manual file uploads with email attachments. When a user manually uploaded a file, the email attachments were ignored, and vice versa.

### Root Cause

In `client/src/features/office/hooks/useOfficeChatAdapter.js`, the code used nullish coalescing (`??`) to choose between manual uploads and email attachments:

```javascript
// Old behavior (lines 52-53)
imageData: apiMessage.imageData ?? mailImageData,
fileData: apiMessage.fileData ?? mailFileData
```

This meant:
- If `apiMessage.imageData` exists (manual upload), `mailImageData` is ignored
- If `apiMessage.fileData` exists (manual upload), `mailFileData` is ignored

## Solution

Added a `combineUploadData()` helper function that merges both manual uploads and email attachments into a single array.

### Implementation Details

**File Modified:** `client/src/features/office/hooks/useOfficeChatAdapter.js`

**New Function:**
```javascript
function combineUploadData(manualData, mailData) {
  // If both are present, combine them into an array
  if (manualData && mailData) {
    const manualArray = Array.isArray(manualData) ? manualData : [manualData];
    return [...manualArray, ...mailData];
  }

  // If only manual data exists, return it as-is
  if (manualData) {
    return manualData;
  }

  // If only mail data exists, return it
  if (mailData) {
    return mailData;
  }

  // Neither exists
  return null;
}
```

**Updated Usage:**
```javascript
const combinedImageData = combineUploadData(apiMessage.imageData, mailImageData);
const combinedFileData = combineUploadData(apiMessage.fileData, mailFileData);

chat.sendMessage({
  displayMessage,
  apiMessage: {
    ...apiMessage,
    content: enrichedContent,
    imageData: combinedImageData,
    fileData: combinedFileData
  },
  // ...
});
```

## Data Structure Compatibility

The solution works because the server's `RequestBuilder.preprocessMessagesWithFileData()` function already supports both:
- Single object: `{ base64, fileType, fileName, ... }`
- Array of objects: `[{ base64, fileType, fileName, ... }, ...]`

### Manual Upload Format
Single object with structure:
```javascript
{
  type: 'image' | 'file',
  source: 'local',
  base64: '...',
  fileName: '...',
  fileType: '...',
  fileSize: number
}
```

### Email Attachment Format
Array of objects with same structure:
```javascript
[
  {
    source: 'local',
    base64: '...',
    fileName: '...',
    fileType: '...',
    fileSize: number
  }
]
```

## Testing Scenarios

To verify the fix works correctly, test these scenarios:

### Scenario 1: Manual Upload Only
1. Open Outlook add-in
2. Select an email (no attachments)
3. Manually upload a file via the upload button
4. Send a message
5. **Expected:** File is included in the API request

### Scenario 2: Email Attachments Only
1. Open Outlook add-in
2. Select an email with attachments
3. Don't manually upload any files
4. Send a message
5. **Expected:** Email attachments are included in the API request

### Scenario 3: Both Manual Upload and Email Attachments ✨ NEW
1. Open Outlook add-in
2. Select an email with attachments (e.g., PDF, image)
3. Manually upload an additional file via the upload button
4. Send a message
5. **Expected:** Both manual upload AND email attachments are included in the API request

### Scenario 4: Neither
1. Open Outlook add-in
2. Select an email without attachments
3. Don't manually upload any files
4. Send a message
5. **Expected:** Message sent successfully without any files

## Code Quality

- ✅ ESLint checks passed (no new warnings)
- ✅ Prettier formatting applied
- ✅ No breaking changes to existing functionality
- ✅ Backward compatible with single-file uploads

## Related Files

- `client/src/features/office/hooks/useOfficeChatAdapter.js` - Main fix
- `client/src/features/office/components/OfficeChatPanel.jsx` - Calls the adapter
- `client/src/features/office/utilities/buildChatApiMessages.js` - Processes email attachments
- `server/services/chat/RequestBuilder.js` - Server-side file data processing

## Notes

- The server already supported array inputs for `fileData` and `imageData`
- No server-side changes were required
- The fix maintains backward compatibility with existing code
- Manual uploads are now combined with email attachments rather than replacing them
