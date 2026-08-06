# Auto Send Starter Prompts

**Date:** 2025-11-06  
**Status:** Implemented  
**Related Issue:** Auto Send Starter Prompt

## Overview

This feature adds the ability to configure starter prompts to automatically send their message when clicked, instead of just pasting it into the input field. This is useful for prompts that are ready to be sent immediately without requiring user modification.

## Problem Statement

Previously, all starter prompts would paste their message into the chat input field, requiring users to manually click the send button. For some prompts that are complete and don't require user modification, this extra step was unnecessary. Additionally, for longer prompts, having them immediately sent provides a better user experience.

## Solution

Added an optional `autoSend` boolean property to the starter prompt schema. When enabled:
- Clicking the starter prompt immediately sends the message to the AI
- The message is not pasted into the input field
- Variables (if any) are still applied before sending

When disabled (default behavior):
- Original behavior is maintained
- Message is pasted into the input field
- User can review/modify before sending

## Implementation Details

### Schema Changes

**File:** `server/validators/appConfigSchema.js`

Added `autoSend` property to the `starterPromptSchema`:

```javascript
const starterPromptSchema = z.object({
  title: localizedStringSchema,
  message: localizedStringSchema,
  variables: z.record(z.any()).optional(),
  autoSend: z.boolean().optional().default(false)
});
```

### Admin UI Changes

**File:** `client/src/features/admin/components/AppFormEditor.jsx`

1. Updated `addStarterPrompt` function to initialize `autoSend: false` for new prompts
2. Added a checkbox UI element for configuring the `autoSend` property:

```jsx
<div className="flex items-center">
  <input
    type="checkbox"
    checked={prompt.autoSend || false}
    onChange={e => handleStarterPromptChange(index, 'autoSend', e.target.checked)}
    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
  />
  <label className="ml-2 block text-sm text-gray-900">
    {t('admin.apps.edit.autoSendPrompt', 'Send immediately when clicked')}
  </label>
</div>
```

### Frontend Logic Changes

**File:** `client/src/features/apps/pages/AppChat.jsx`

Updated `handleStarterPromptClick` function to handle auto-send:

```javascript
const handleStarterPromptClick = prompt => {
  if (prompt && typeof prompt === 'object') {
    if (prompt.message) {
      setInput(prompt.message);
    }
    if (prompt.variables) {
      setVariables(prev => ({ ...prev, ...prompt.variables }));
    }
    
    // If autoSend is enabled, automatically submit the form
    if (prompt.autoSend) {
      setTimeout(() => {
        const form = document.querySelector('form');
        if (form) {
          const submitEvent = new Event('submit', {
            cancelable: true,
            bubbles: true
          });
          form.dispatchEvent(submitEvent);
        }
      }, 0);
    } else {
      // Only focus input if not auto-sending
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  } else {
    setInput(prompt);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }
};
```

### Example Configuration

**File:** `server/defaults/apps/mermaid-diagrams.json`

Added `autoSend: true` to the first starter prompt as an example:

```json
{
  "title": {
    "en": "Create a flowchart for user authentication process",
    "de": "Erstelle ein Flussdiagramm für den Benutzeranmeldeprozess"
  },
  "message": {
    "en": "Create a flowchart showing the steps for user authentication including login, password reset, and account creation.",
    "de": "Erstelle ein Flussdiagramm, das die Schritte für die Benutzeranmeldung einschließlich Login, Passwortzurücksetzung und Kontoerstellung zeigt."
  },
  "autoSend": true
}
```

## Configuration

The `autoSend` property is:
- **Type:** Boolean
- **Required:** No (optional)
- **Default:** `false`
- **Scope:** Per starter prompt (each starter prompt in an app can have its own setting)

## Backward Compatibility

This change is fully backward compatible:
- Existing starter prompts without the `autoSend` property will default to `false`
- The original behavior (paste to input) is preserved as the default
- No migration is required for existing configurations

## User Experience

### Before
1. User clicks starter prompt
2. Message is pasted into input field
3. User reviews message
4. User clicks send button

### After (with autoSend enabled)
1. User clicks starter prompt
2. Message is immediately sent to AI

### After (with autoSend disabled - default)
1. Same as "Before" - original behavior maintained

## Testing

Manual testing confirmed:
- Server starts without validation errors
- Schema validation accepts the new property
- Admin UI displays the checkbox correctly
- Frontend logic correctly handles both autoSend states
- Example configuration loads successfully

## Files Modified

1. `server/validators/appConfigSchema.js` - Schema definition
2. `client/src/features/admin/components/AppFormEditor.jsx` - Admin UI
3. `client/src/features/apps/pages/AppChat.jsx` - Frontend logic
4. `server/defaults/apps/mermaid-diagrams.json` - Example configuration

## Future Enhancements

Potential future improvements:
- Add i18n translations for the checkbox label to the shared i18n files
- Add visual indicator on starter prompt buttons to show which ones will auto-send
- Add confirmation dialog option for auto-send prompts (configurable per prompt)
- Support for autoSend with required variables (show variable input first, then auto-send)
