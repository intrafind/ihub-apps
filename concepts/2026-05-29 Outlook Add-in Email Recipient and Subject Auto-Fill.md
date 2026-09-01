# Outlook Add-in: Email Recipient and Subject Auto-Fill

**Date:** 2026-05-29
**Issue:** #1137
**Status:** Implemented

## Overview

Enhanced the Outlook add-in's "Add to email" functionality to automatically populate the recipient and subject fields when inserting AI-generated content into a new email reply. Previously, users had to manually copy this information from the original email.

## Problem Statement

When users clicked "Add to email" in the Outlook add-in to insert AI-generated content:
- The reply form opened with only the email body pre-filled
- The recipient field was empty
- The subject field was empty
- Users had to manually copy the sender's email address and subject from the original email

This created unnecessary friction in the workflow and reduced the value of the quick action.

## Solution

Modified the `displayReplyFormWithAssistantResponse` function in `client/src/features/office/utilities/replyForm.js` to:

1. **Extract sender email** from the current mail item using two fallback properties:
   - Primary: `item.from.emailAddress`
   - Fallback: `item.sender.emailAddress`

2. **Extract original subject** from the mail item:
   - Uses `item.subject` (available as string in read mode)

3. **Populate reply form** using Office.js `displayReplyFormAsync` parameters:
   - `toRecipients`: Set to sender's email address
   - `subject`: Set to original subject with "Re: " prefix (if not already present)
   - `htmlBody`: AI-generated content (existing functionality)

## Implementation Details

### New Helper Functions

```javascript
/**
 * Helper to extract sender email address from the current mail item.
 * Returns the sender's email address or null if unavailable.
 */
function getSenderEmailAddress(item) {
  try {
    // In read mode, sender is available directly
    if (item.from && item.from.emailAddress) {
      return item.from.emailAddress;
    }
    // Fallback to sender property if from is not available
    if (item.sender && item.sender.emailAddress) {
      return item.sender.emailAddress;
    }
  } catch (e) {
    console.warn('[iHub] Could not extract sender email:', e);
  }
  return null;
}

/**
 * Helper to get the subject from the current mail item.
 * Returns subject string or null if unavailable.
 */
function getSubject(item) {
  try {
    // In read mode, subject is directly available as a string
    if (typeof item.subject === 'string') {
      return item.subject;
    }
  } catch (e) {
    console.warn('[iHub] Could not extract subject:', e);
  }
  return null;
}
```

### Updated displayReplyFormAsync Call

```javascript
// Build the form data object with body, recipient, and subject
const formData = { htmlBody: html };

// Extract sender email to set as recipient
const senderEmail = getSenderEmailAddress(item);
if (senderEmail) {
  formData.toRecipients = [senderEmail];
}

// Extract subject and prefix with "Re: " if not already present
const originalSubject = getSubject(item);
if (originalSubject) {
  // Add "Re: " prefix if it's not already there
  const subjectPrefix = 'Re: ';
  formData.subject = originalSubject.startsWith(subjectPrefix)
    ? originalSubject
    : subjectPrefix + originalSubject;
}

item.displayReplyFormAsync(formData, result => {
  if (result.status === Office.AsyncResultStatus.Failed) {
    console.error('[iHub] displayReplyFormAsync failed:', result.error);
    window.alert('Could not open reply form. ' + (result.error?.message || ''));
  }
});
```

## Technical Considerations

### Office.js API Compatibility

- **displayReplyFormAsync**: Available in Mailbox API 1.1+ (supported by all modern Outlook clients)
- **Read Mode Only**: This feature only applies when the add-in is opened in read mode (viewing an existing email)
- **Compose Mode**: When in compose mode, the function uses `prependAsync` to insert content directly into the draft body (no recipient/subject needed as they're already set)

### Properties Used

- **`item.from`**: Primary source for sender information (Office.js EmailAddressDetails)
- **`item.sender`**: Fallback source if `from` is unavailable
- **`item.subject`**: Email subject (available as string in read mode)

### Error Handling

- Graceful fallback if sender email cannot be extracted (recipient field left empty)
- Graceful fallback if subject cannot be extracted (subject field left empty)
- Console warnings logged for debugging purposes
- No user-facing errors for missing metadata

## User Experience Impact

**Before:**
1. User generates AI response in Outlook add-in
2. User clicks "Add to email"
3. Reply form opens with only body filled
4. User manually types/copies recipient email
5. User manually types/copies subject with "Re: " prefix
6. User sends email

**After:**
1. User generates AI response in Outlook add-in
2. User clicks "Add to email"
3. Reply form opens with:
   - Body: AI-generated content
   - To: Sender's email address
   - Subject: "Re: [original subject]"
4. User reviews and sends email

**Time Saved:** ~10-15 seconds per email (eliminating manual copy/paste steps)

## Testing Considerations

### Manual Testing Required

- [ ] Test in Outlook Web (read mode with displayReplyFormAsync)
- [ ] Test in Outlook Desktop (Windows/Mac)
- [ ] Test in compose mode (should use prependAsync, no changes)
- [ ] Test with emails that have no sender (fallback behavior)
- [ ] Test with emails that already have "Re: " in subject
- [ ] Test with forwarded emails (Fwd: prefix)

### Edge Cases

- **No sender information**: Field left empty, function continues gracefully
- **Subject already has "Re: "**: Does not duplicate the prefix
- **Very long subjects**: Office.js handles truncation automatically
- **International characters**: Unicode support handled by Office.js

## Related Files

- **Implementation**: `client/src/features/office/utilities/replyForm.js`
- **Documentation**: `docs/outlook-add-in.md`
- **Context**: Used by `client/src/features/office/components/OfficeChatPanel.jsx` (handleInsert callback)

## Future Enhancements

Potential improvements to consider:

1. **CC/BCC Support**: Add support for copying CC/BCC recipients from original email
2. **Reply-All Support**: Option to include all original recipients
3. **Forward Mode**: Support for "Forward" action with "Fwd: " prefix
4. **Smart Subject Detection**: Handle various subject prefixes (RE:, Re:, FW:, Fwd:, etc.)
5. **User Preferences**: Allow users to configure default reply behavior

## References

- **Office.js Documentation**: [displayReplyFormAsync](https://learn.microsoft.com/en-us/javascript/api/outlook/office.messageread?view=outlook-js-preview#outlook-office-messageread-displayreplyformasync-member(1))
- **Issue**: #1137 - Check if we set the recipient and/or title of a mail
- **Commit**: 0c3d469 - feat(outlook): set recipient and subject when adding to email
