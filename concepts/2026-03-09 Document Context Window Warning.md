# Document Context Window Warning

**Date:** 2026-03-09  
**Issue:** Hint that the document is too long for the context window

## Problem Statement

When users upload a document that is too large to fit within the LLM model's context window, the request fails hard with a cryptic error from the LLM API. Users are not informed upfront that their document is too large.

## Solution

Add a client-side warning that checks the estimated token count of uploaded document files against the selected model's context window size, and displays a warning banner to the user before they send the message.

## Implementation

### Token Estimation

Client-side token count estimation uses the standard approximation of **1 token ≈ 4 characters** (English text). This is a rough heuristic sufficient for detecting documents that are clearly too large.

### Warning Threshold

A warning is shown when the estimated document token count exceeds **80% of the model's `tokenLimit`**. This threshold leaves room for:
- System prompt
- User message
- Model response

### Warning Display

The warning is displayed as an amber/yellow banner inside the chat input area, directly above the form, after the attached files list. It appears immediately when a document is selected and disappears when the file is removed.

### User Experience

The warning is **non-blocking** — users can still submit the message if they choose to. The warning informs them that:
1. The estimated token count of the document
2. The model's context window size
3. That the request may fail
4. Suggestions: use a shorter document or choose a model with a larger context window

## Files Changed

- `client/src/features/apps/pages/AppChat.jsx` — Added `fileTokenWarning` state and `useEffect` to calculate the warning
- `client/src/features/chat/components/ChatInput.jsx` — Added `fileTokenWarning` prop and warning banner display
- `shared/i18n/en.json` — Added `errors.documentTooLarge` translation key
- `shared/i18n/de.json` — Added German translation for the warning

## Related Code

- `server/services/chat/RequestBuilder.js` — `preprocessMessagesWithFileData()` — where file content is added to messages
- `server/utils/ErrorHandler.js` — `isContextWindowError()` — detects context window errors after they occur (server-side)
- `client/src/features/upload/utils/fileProcessing.js` — `processDocumentFile()` — extracts text from uploaded documents
