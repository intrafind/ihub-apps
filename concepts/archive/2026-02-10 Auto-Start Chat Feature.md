# Auto-Start Chat Feature Implementation

**Date:** 2026-02-10  
**Feature:** Proactive Conversation Initialization for Dialog-Based Apps

## Overview

This feature enables AI apps to start conversations proactively, eliminating the need for users to send an initial message. When enabled, apps can greet users and begin the dialogue automatically, creating a more engaging and coach-like experience.

## Problem Statement

Previously, users had to send an empty or initial message to begin a conversation with dialog-based apps (e.g., coaching apps). This created an awkward user experience where:
- Users had to figure out what to say first
- The app couldn't take the initiative to guide the conversation
- Dialog-based coaching scenarios felt unnatural

## Solution

We implemented an `autoStart` configuration option that:
1. Automatically triggers the LLM when the chat is opened or reset
2. Sends an invisible empty message to the LLM to start the conversation
3. Shows only the LLM's response as the first visible message
4. Provides a natural, welcoming start to dialog-based interactions

## Implementation Details

### 1. Schema Extension

**File:** `server/validators/appConfigSchema.js`

Added a new optional boolean field:
```javascript
autoStart: z.boolean().optional().default(false)
```

This field allows app configurations to opt-in to auto-start behavior.

### 2. Admin UI Enhancement

**File:** `client/src/features/admin/components/AppFormEditor.jsx`

Added a checkbox control with help text:
- Only visible for chat-type apps (not iframe or redirect apps)
- Clear label: "Auto-start conversation"
- Helpful description explaining when the feature triggers
- Follows existing UI patterns for consistency

### 3. Auto-Start Logic

**File:** `client/src/features/apps/pages/AppChat.jsx`

Implemented smart auto-start detection:
```javascript
const shouldAutoStart =
  app?.autoStart === true &&        // Feature enabled
  messages.length === 0 &&          // No existing messages
  !processing &&                    // Not currently processing
  !autoStartTriggered.current &&    // Not already triggered
  selectedModel &&                  // Model selected
  app.variables;                    // Variables initialized
```

**Trigger Behavior:**
- Resets when `appId` or `chatId` changes
- Includes 300ms delay to ensure proper initialization
- Sends empty message with proper parameters and validated variables
- Respects all app settings (model, temperature, output format, etc.)

### 4. Message Display Filtering

**File:** `client/src/features/chat/components/ChatMessageList.jsx`

Enhanced message rendering to filter empty user messages:
```javascript
const displayedMessages = messages.filter(
  message => !(message.role === 'user' && (!message.content || message.content.trim() === ''))
);
```

This ensures the empty trigger message is never shown to users while still being sent to the LLM.

### 5. Internationalization

**Files:** `shared/i18n/en.json`, `shared/i18n/de.json`

Added translations for the feature:
- English: "Auto-start conversation" with helpful description
- German: "Konversation automatisch starten" with German description

### 6. Example Application

**File:** `examples/apps/coach-dialog.json`

Created a demonstration app with:
- `autoStart: true` enabled
- Coaching-style system prompt
- Warm greeting instructions
- Shows best practices for dialog-based apps

## User Experience

### Before Auto-Start
1. User opens app
2. User sees empty chat with input field
3. User must type something to start (even if they don't know what to say)
4. LLM responds

### After Auto-Start
1. User opens app
2. LLM immediately greets user and asks how it can help
3. User can respond naturally to the greeting
4. Conversation flows smoothly from the start

## Technical Considerations

### Message Flow
1. App loads with `autoStart: true` and no messages
2. Auto-start effect triggers after initialization
3. Empty message sent via `sendChatMessage()` with all proper parameters
4. User message added to messages array (empty content)
5. LLM processes empty message and generates greeting
6. ChatMessageList filters out empty user message
7. Only LLM's greeting is displayed

### Edge Cases Handled
- **Multiple triggers prevented:** Uses `autoStartTriggered.current` ref
- **App switching:** Resets trigger when `appId` changes
- **Chat clearing:** Resets trigger when `chatId` changes
- **Race conditions:** Waits for models and variables to load
- **Processing state:** Won't trigger if already processing

### Performance Impact
- Minimal: One additional `useEffect` hook
- No significant overhead
- Auto-start delay (300ms) allows proper initialization without noticeable lag

## Configuration Example

```json
{
  "id": "personal-coach",
  "name": {
    "en": "Personal Coach",
    "de": "Persönlicher Coach"
  },
  "system": {
    "en": "You are a helpful personal coach. Start by greeting the user warmly...",
    "de": "Du bist ein hilfreicher Coach. Beginne mit einer herzlichen Begrüßung..."
  },
  "autoStart": true,
  "tokenLimit": 8192,
  "enabled": true
}
```

## Testing Recommendations

1. **Basic Functionality:**
   - Open app with `autoStart: true` → LLM should greet immediately
   - Open app with `autoStart: false` → Normal behavior (no auto-start)
   - Verify empty user message is not shown in UI

2. **Chat Reset:**
   - Clear chat → LLM should auto-start again
   - Switch between apps → Each app respects its own `autoStart` setting

3. **Variables:**
   - Apps with variables should auto-start with default values
   - Required variables should be validated before trigger

4. **Edge Cases:**
   - Rapid app switching
   - Network delays
   - Multiple chat sessions

## Future Enhancements

Possible improvements:
1. **Configurable delay:** Allow apps to customize the auto-start delay
2. **Custom trigger message:** Option to send specific content instead of empty message
3. **Conditional auto-start:** Trigger based on user profile or time of day
4. **Analytics:** Track auto-start engagement metrics

## Related Files

### Core Implementation
- `server/validators/appConfigSchema.js` - Schema definition
- `client/src/features/apps/pages/AppChat.jsx` - Auto-start logic
- `client/src/features/chat/components/ChatMessageList.jsx` - Message filtering
- `client/src/features/admin/components/AppFormEditor.jsx` - Admin UI

### Supporting Files
- `shared/i18n/en.json` - English translations
- `shared/i18n/de.json` - German translations
- `examples/apps/coach-dialog.json` - Example configuration

## Conclusion

The auto-start feature successfully enables dialog-based apps to take the initiative in conversations, creating more natural and engaging user experiences. The implementation is clean, performant, and follows existing architectural patterns in the codebase.
