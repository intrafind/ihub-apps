# Copy Link Quick Action for Chat Messages

**Date:** 2026-02-02  
**Status:** Implemented  
**Feature Type:** Quick Action / User Experience Enhancement

## Overview

This feature adds a new quick action button to user messages in the chat interface that allows users to copy a shareable link with the message content pre-filled and set to auto-execute. This enables teams to quickly create and share executable links that automatically run when opened by the recipient.

## Problem Statement

Users needed a quick way to share messages with colleagues that would:
1. Automatically populate the message input with specific content
2. Execute the message immediately when the link is opened
3. Include any variables that were set in the original message

The existing workflow required manually constructing URLs with query parameters, which was error-prone and time-consuming.

## Solution

Added a "Copy Link" quick action button to user messages that:
- Generates a shareable URL with the message content
- Includes `prefill` parameter with the message text
- Includes `send=true` to trigger automatic execution
- Preserves all variables from the original message

## Implementation Details

### Files Modified

1. **`shared/i18n/en.json`** - Added English translations:
   - `chatMessage.copyLink`: "Copy link"
   - `chatMessage.linkCopied`: "Link copied!"

2. **`shared/i18n/de.json`** - Added German translations:
   - `chatMessage.copyLink`: "Link kopieren"
   - `chatMessage.linkCopied`: "Link kopiert!"

3. **`client/src/features/chat/components/ChatMessage.jsx`** - Core implementation:
   - Added `linkCopied` state to track copy status
   - Implemented `handleCopyLink()` function that:
     - Constructs the base URL from current location
     - Extracts message content (using `message.meta.rawContent` if available)
     - Adds `prefill` parameter with encoded message text
     - Adds `send=true` parameter for auto-execution
     - Includes all variables from `message.meta.variables` as URL parameters
     - Copies the final URL to clipboard
   - Added copy link button in the user message actions section
   - Button shows link icon normally, check icon when copied

### URL Structure

The generated URL follows this pattern:

```
{baseUrl}?prefill={encodedMessage}&send=true&model={modelId}&{variable1}={value1}&{variable2}={value2}...
```

**Note:** The `model` parameter is only included when:
1. There are more than one model available (after filtering by allowedModels, tools, and settings)
2. The selected model is NOT the default/preferred model

**Examples:**

Single model app (no model parameter):
```
https://ihub.example.com/apps/translator?prefill=Hello%20World&send=true&targetLanguage=German
```

Multiple models with default selected (no model parameter):
```
https://ihub.example.com/apps/chat?prefill=Explain%20quantum%20physics&send=true
```

Multiple models with non-default selected (model parameter included):
```
https://ihub.example.com/apps/chat?prefill=Explain%20quantum%20physics&send=true&model=gemini-2.5-pro
```

### Key Features

1. **Automatic Message Population**: The `prefill` parameter pre-fills the chat input
2. **Auto-Execution**: The `send=true` parameter triggers automatic message sending
3. **Variable Preservation**: All app variables are included in the URL
4. **Smart Model Inclusion**: The `model` parameter is included only when necessary (multiple models + non-default selection)
5. **User Feedback**: Visual feedback with icon change when link is copied
6. **i18n Support**: Fully internationalized with English and German translations

### Code Location

**Link Generation Logic:**
```javascript
// File: client/src/features/chat/components/ChatMessage.jsx
// Lines: ~150-220

const handleCopyLink = () => {
  // Get the current page URL (without query params)
  const currentUrl = new URL(window.location.href);
  const baseUrl = `${currentUrl.origin}${currentUrl.pathname}`;

  // Get the message content (raw content if available, otherwise regular content)
  const messageContent =
    message.meta?.rawContent || (typeof message.content === 'string' ? message.content : '');

  // Create URLSearchParams to build the query string
  const params = new URLSearchParams();

  // Add prefill parameter with the message content
  params.set('prefill', messageContent);

  // Add send=true to auto-execute
  params.set('send', 'true');

  // Add variables if they exist
  const variables = message.meta?.variables || message.variables;
  if (variables && Object.keys(variables).length > 0) {
    Object.entries(variables).forEach(([key, value]) => {
      params.set(key, value);
    });
  }

  // Determine if we should include the model parameter
  // Model should be included if:
  // 1. There are more than one model available (after filtering)
  // 2. The selected model is not the default/preferred model
  if (app && models && models.length > 0 && modelId) {
    // Filter models the same way as ModelSelector.jsx
    let availableModels =
      app.allowedModels && app.allowedModels.length > 0
        ? models.filter(model => app.allowedModels.includes(model.id))
        : models;

    // Filter by tools requirement
    if (app.tools && app.tools.length > 0) {
      availableModels = availableModels.filter(model => model.supportsTools);
    }

    // Apply model settings filter if specified
    if (app.settings?.model?.filter) {
      const filter = app.settings.model.filter;
      availableModels = availableModels.filter(model => {
        for (const [key, value] of Object.entries(filter)) {
          if (model[key] !== value) {
            return false;
          }
        }
        return true;
      });
    }

    // Check if there are multiple models available
    if (availableModels.length > 1) {
      // Determine the default model
      // Priority: app.preferredModel > model with default flag > first available model
      const defaultModelFromList = availableModels.find(m => m.default);
      const defaultModel =
        app.preferredModel ||
        (defaultModelFromList ? defaultModelFromList.id : availableModels[0]?.id);

      // Include model parameter only if selected model is not the default
      if (modelId !== defaultModel) {
        params.set('model', modelId);
      }
    }
  }

  // Construct the final URL
  const shareableLink = `${baseUrl}?${params.toString()}`;

  // Copy to clipboard
  navigator.clipboard
    .writeText(shareableLink)
    .then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    })
    .catch(err => {
      console.error('Failed to copy link: ', err);
    });
};
```

**Button Rendering:**
```jsx
// File: client/src/features/chat/components/ChatMessage.jsx
// Lines: ~685-695

<button
  onClick={handleCopyLink}
  className="flex items-center gap-1 hover:text-blue-600 transition-colors duration-150"
  title={t('chatMessage.copyLink', 'Copy link')}
>
  {linkCopied ? (
    <Icon name="check" size="sm" />
  ) : (
    <Icon name="link" size="sm" />
  )}
</button>
```

## User Experience

### Before Implementation
Users had to:
1. Manually construct URLs with `?prefill=...&send=true`
2. URL-encode message content themselves
3. Remember to include all necessary variables
4. Share the URL via copy-paste

### After Implementation
Users can:
1. Hover over any user message
2. Click the link icon in the message actions
3. Share the copied URL immediately
4. Recipients see the message auto-execute when opening the link

### Visual Feedback
- **Normal State**: Link icon displayed
- **Copied State**: Check icon displayed for 2 seconds
- **Tooltip**: "Copy link" on hover

## Testing Scenarios

### Test Case 1: Simple Message
**Input:** User message "Hello world"  
**Expected URL:** `{base}?prefill=Hello%20world&send=true`

### Test Case 2: Message with Variables
**Input:** User message "Translate this" with `targetLanguage=German`  
**Expected URL:** `{base}?prefill=Translate%20this&send=true&targetLanguage=German`

### Test Case 3: Multiple Variables
**Input:** User message with multiple app variables  
**Expected URL:** All variables included as separate query parameters

### Test Case 4: Special Characters
**Input:** Message with special characters (`&`, `=`, etc.)  
**Expected:** Proper URL encoding of all special characters

### Test Case 5: Single Model (No Model Parameter)
**Input:** User message in an app with only one model available  
**Expected URL:** No `model` parameter included  
**Example:** `{base}?prefill=Test&send=true`

### Test Case 6: Multiple Models - Default Selected (No Model Parameter)
**Input:** User message using the default/preferred model when multiple models are available  
**Expected URL:** No `model` parameter included  
**Example:** `{base}?prefill=Test&send=true`

### Test Case 7: Multiple Models - Non-Default Selected (Model Parameter Included)
**Input:** User message using a non-default model when multiple models are available  
**Expected URL:** `model` parameter included with the selected model ID  
**Example:** `{base}?prefill=Test&send=true&model=gemini-2.5-pro`

## Integration Points

### Existing Features
- **Prefill/Send System**: Leverages existing `prefill` and `send` parameter handling in `AppChat.jsx`
- **Variables System**: Uses existing variable storage in `message.meta.variables`
- **Message Actions**: Integrates with existing message action buttons (edit, resend, delete)
- **i18n**: Follows existing internationalization patterns

### Related Code
- `client/src/features/apps/pages/AppChat.jsx`: Handles `prefill` and `send` parameters
- `client/src/features/chat/components/ChatMessage.jsx`: User message rendering and actions
- `shared/i18n/`: Translation files for UI text

## Security Considerations

1. **URL Encoding**: All parameters are properly URL-encoded to prevent injection attacks
2. **Content Length**: No validation on URL length (browser limits apply)
3. **Variable Validation**: Variables are passed as-is from the message metadata
4. **No Sensitive Data**: Links contain only what the user already sent

## Future Enhancements

Potential improvements:
1. **Short Links**: Integration with short link system for cleaner URLs
2. **Expiration**: Optional link expiration for temporary shares
3. **QR Codes**: Generate QR codes for mobile sharing
4. **Link Preview**: Show preview before copying
5. **Analytics**: Track link usage and execution

## Known Limitations

1. **Browser URL Length**: Very long messages or many variables may exceed browser URL limits (typically 2048 characters)
2. **No Server-Side Storage**: Links are generated client-side only
3. **No Access Control**: Anyone with the link can use it (assuming they have app access)
4. **No Link Revocation**: Once shared, links cannot be invalidated

## Maintenance Notes

- Translation keys follow the pattern `chatMessage.{actionName}`
- Button styling uses existing Tailwind classes for consistency
- Icon changes follow the same pattern as other action buttons (copy/copied)
- State management uses simple `useState` for copy feedback

## Documentation Updates Required

- User guide: Add section on sharing messages via links
- FAQ: Explain URL parameter usage
- API docs: Document prefill/send parameters (if not already documented)

## Related Issues/PRs

- Issue: "New quick action for chat input messages"
- PR: #[PR_NUMBER] - Copy Link Quick Action Implementation

## Updates (2026-02-03)

### Model Parameter Support

**Issue:** "Link for a message should contain the model if more than 1"

**Implementation:** Enhanced the `handleCopyLink()` function to conditionally include the model parameter in generated links.

**Key Changes:**
1. Added `models` prop to `ChatMessage`, `ChatMessageList`, `CanvasChatPanel` components
2. Modified `handleCopyLink()` to:
   - Filter available models using the same logic as `ModelSelector` (allowedModels, tools, settings filters)
   - Determine the default model (preferredModel > default flag > first model)
   - Include `model` parameter only when:
     - Multiple models are available after filtering
     - Selected model differs from the default model

**Files Modified:**
- `client/src/features/chat/components/ChatMessage.jsx` - Added model filtering and conditional model parameter logic
- `client/src/features/chat/components/ChatMessageList.jsx` - Pass models prop to ChatMessage
- `client/src/features/apps/pages/AppChat.jsx` - Pass models from useAppSettings hook
- `client/src/features/canvas/components/CanvasChatPanel.jsx` - Added models and modelId props
- `client/src/features/canvas/pages/AppCanvas.jsx` - Pass models to CanvasChatPanel

**Benefit:** Users sharing links with non-default models will now have those model selections preserved, ensuring recipients use the same model when executing the shared link.
