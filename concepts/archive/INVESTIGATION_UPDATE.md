# Investigation Update: Image Persistence Issue

## User Feedback

@manzke reported that the issue still persists even though the `done` event is being received for the second image. This indicates that my original hypothesis (that `loading: true` was blocking image display) was **incorrect**.

## Actions Taken

### 1. Reverted Incorrect Fix (Commit c8c7aa2)

- Removed the `sanitizeLoadedMessages()` function that was setting `loading: false` for messages with images
- This fix wasn't addressing the real issue since the `done` event IS being received

### 2. Added Comprehensive Debugging (Commits c8c7aa2, 069979e)

Added detailed logging throughout the message lifecycle to track exactly where images are being lost:

**`updateAssistantMessage` function:**

```javascript
- Logs when images are added/updated
- Shows image counts before and after update
- Tracks whether update is in loading state
```

**Save to sessionStorage:**

```javascript
- Logs when messages with images are saved
- Shows total message count and how many have images
- Displays image details (id, count, loading state)
```

**Load from sessionStorage:**

```javascript
- Logs raw sessionStorage data (first 200 chars)
- Shows parsed message structure
- Validates image data exists and has content
- Logs all messages even if no images
```

**ChatId changes:**

```javascript
- Logs when loading messages for new chatId
- Shows same detailed info as initial load
```

## Current Hypothesis

The images are likely being lost in one of these scenarios:

1. **Not being saved to sessionStorage** - Images are added but state update doesn't persist
2. **Being saved but without image data** - Images array exists but data is empty/corrupted
3. **SessionStorage quota exceeded** - Large base64 images might exceed storage limits
4. **Message merging issue** - The `done` event might be overwriting the images

## Next Steps for Debugging

1. User should test with console open and share the logs showing:
   - What gets saved when second image is generated
   - What's in raw sessionStorage data
   - What gets loaded when returning to app

2. Based on logs, we can identify:
   - Are images in the state when saved?
   - Are images in sessionStorage?
   - Are images being loaded from sessionStorage?
   - If they're loaded, why aren't they displaying?

## Expected Console Output Pattern

**When generating second image:**

```
🖼️ Image update for message xxx : { previousImages: 1, extraImages: 1, resultImages: 2, isLoading: true }
✅ Setting message to completed state: { id: xxx, contentLength: 50, hasImages: false, imageCount: 0 }
💾 Saving messages to sessionStorage: { totalMessages: 4, messagesWithImages: 1, imageDetails: [...] }
```

**When returning to app:**

```
📂 Raw sessionStorage data for key ai_hub_chat_messages_chat-xxx : [{"id":"user-...
📂 Loading messages from sessionStorage: { totalMessages: 4, messagesWithImages: 1, imageDetails: [...] }
```

If the console shows different patterns, we'll know exactly where the problem is.
