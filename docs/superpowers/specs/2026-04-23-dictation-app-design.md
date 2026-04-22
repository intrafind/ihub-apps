# Dictation App Design Spec

**Date:** 2026-04-23
**Status:** Draft

## Context

A customer wants a voice-driven document creation app. The user dictates what they want (e.g., "write an email to my boss about the project delay"), the LLM generates a document in the canvas editor, and the user can continue refining it by dictating further instructions or editing manually. The user can also go back to their original instructions, adjust them, and regenerate.

The existing canvas mode (`/apps/:appId/canvas`) has the right structure — split chat/editor panel, Quill rich-text editor, voice input, AI toolbox — but several bugs prevent it from working correctly, and the workflow needs enhancements to deliver the seamless dictation loop.

## Bugs to Fix (Blocking Correctness)

### 1. System prompt bypassed in canvas (`bypassAppPrompts: true`)

**File:** `client/src/features/canvas/pages/AppCanvas.jsx:216`

Every message from canvas hardcodes `bypassAppPrompts: true`, which causes `RequestBuilder.js` to skip the app's system prompt entirely. The LLM in canvas has no persona, no instructions, no document workflow guidance.

**Fix:** Only set `bypassAppPrompts: true` when the message is an AI edit action (FloatingToolbox). For normal user messages in the chat panel, set `bypassAppPrompts: false`. Detect edit actions via `options?.editAction` already present in the call site.

```js
// Before (line 216):
bypassAppPrompts: true,

// After:
bypassAppPrompts: !!options?.editAction,
```

### 2. Content transfer via URL is length-limited

**File:** `client/src/features/apps/pages/AppChat.jsx:349-351`

Initial document content is passed to canvas via `?content=<URL-encoded-string>`. This truncates documents longer than ~8000 chars. Generated documents often exceed this.

**Fix:** Store content in `sessionStorage` under `canvas_initial_content_${appId}` and pass a `?hasContent=1` flag in the URL. Canvas reads from sessionStorage on mount and clears it after consumption.

**Files to change:**
- `AppChat.jsx` `handleOpenInCanvas` — write to sessionStorage instead of URL
- `AppCanvas.jsx` `useEffect` for initial content (lines 510–542) — read from sessionStorage

### 3. Canvas creates a new chat session (context loss on auto-redirect)

**File:** `client/src/utils/chatId.js` — canvas uses prefix `'canvas'`, chat uses `'chat'`

When auto-redirect fires, canvas starts a fresh session. The LLM doesn't know what the user originally asked for, so follow-up refinements lack context.

**Fix:** When auto-redirecting to canvas, pass the original `chatId` in the URL (`?chatId=<id>`). Canvas reads this URL parameter and uses it instead of generating a new one. This gives the LLM full conversation history including the initial brief.

**Files to change:**
- `AppChat.jsx` `handleOpenInCanvas` — append `&chatId=<chatId>`
- `AppCanvas.jsx` — read `chatId` param from `searchParams` and initialize `chatId.current` with it if present

### 4. Voice input disabled in canvas chat panel

**File:** `client/src/features/canvas/components/CanvasChatPanel.jsx:83`

The chat panel's `ChatInput` receives an empty no-op `onVoiceInput={() => {}}`. The user cannot dictate refinement instructions to the AI in canvas mode.

**Fix:** Wire up `useVoiceRecognition` in `AppCanvas.jsx` and pass a real `handleVoiceInput` down to `CanvasChatPanel`. The hook already exists and handles Azure + browser modes.

## New Features (Dictation Workflow)

### 5. Auto-apply: LLM responses replace editor content automatically

**Motivation:** The current workflow requires the user to click an "Insert into document" arrow button after every LLM response. For a dictation workflow this is too much friction — the user dictates an instruction and expects the document to update.

**Config flag:** `features.canvas.autoApply: true` in the app JSON config. When enabled:
1. When an assistant message completes in the canvas chat panel, its content is automatically applied to the editor (replacing the full document).
2. The `handleInsertAnswer` function (already at `AppCanvas.jsx:454`) is reused to do the actual insertion/replacement.
3. A `useEffect` in `AppCanvas.jsx` watches `messages` for newly completed assistant messages when `autoApply` is true.
4. The FloatingToolbox edit actions already call `applyEditResult` from `useCanvas.js` — they are unchanged.

**Conflict handling:** Auto-apply should only fire for messages from the chat panel, not for FloatingToolbox edit actions (those use `applyEditResult` in `useCanvas.js` and handle insertion themselves). Detect FloatingToolbox-origin messages via `message.meta?.editAction` being set. If this metadata is present, skip auto-apply.

Auto-apply replaces the full editor content via `setEditorContent` (skipping the confirmation modal for a cleaner experience in dictation mode).

### 6. Full document context sent to LLM

**File:** `client/src/features/canvas/pages/AppCanvas.jsx:192`

Currently only the first 500 chars of the document are sent as context. "Replace in-place" only works correctly when the LLM receives the full current document.

**Fix:** For `autoApply` apps, send the complete editor content (stripped of HTML tags) without the 500-char truncation:

```js
// Before:
contextualInput += `\n\nCurrent document context: ${editorContent.replace(/<[^>]*>/g, '').substring(0, 500)}...`;

// After (when autoApply is enabled):
const fullText = editorContent.replace(/<[^>]*>/g, '').trim();
if (fullText) {
  contextualInput += `\n\nCurrent document:\n${fullText}`;
}
```

## New App Configuration

**File to create:** `contents/apps/dictation-writer.json`

```json
{
  "id": "dictation-writer",
  "name": { "en": "Dictation Writer", "de": "Diktat-Schreiber" },
  "description": {
    "en": "Dictate your ideas and let AI create the document. Refine with your voice.",
    "de": "Diktiere deine Ideen und lass die KI das Dokument erstellen. Mit deiner Stimme verfeinern."
  },
  "color": "#6366F1",
  "icon": "microphone",
  "tokenLimit": 16000,
  "preferredOutputFormat": "markdown",
  "preferredTemperature": 0.5,
  "sendChatHistory": true,
  "features": {
    "canvas": true,
    "canvasAutoApply": true
  },
  "inputMode": {
    "type": "multiline",
    "microphone": {
      "enabled": true,
      "mode": "manual",
      "showTranscript": true
    }
  },
  "system": {
    "en": "You are a professional writing assistant. Your job is to create and refine documents based on the user's voice instructions.\n\n## How you work:\n\n1. **First message**: The user describes what they want to create (e.g., 'Write an email to my boss about a project delay'). Generate a complete, well-formatted document in Markdown.\n\n2. **Follow-up messages**: The user provides instructions to modify the document (e.g., 'make the tone more formal', 'add a section about next steps', 'make it shorter'). Always return the COMPLETE updated document in Markdown — never just the changed section.\n\n## Important rules:\n- Always output the full document, never partial updates\n- Format output in clean Markdown with proper headings, paragraphs, and lists\n- Keep the document focused on what was requested\n- If the current document is provided as context, use it as the base for modifications\n- Do not add meta-commentary or explanations — just return the document content",
    "de": "Du bist ein professioneller Schreibassistent. Deine Aufgabe ist es, Dokumente auf Basis von Sprach-Anweisungen des Nutzers zu erstellen und zu verfeinern.\n\n## Wie du arbeitest:\n\n1. **Erste Nachricht**: Der Nutzer beschreibt, was er erstellen möchte. Erstelle ein vollständiges, gut formatiertes Dokument in Markdown.\n\n2. **Folgenachrichten**: Der Nutzer gibt Anweisungen zur Modifikation. Gib immer das VOLLSTÄNDIGE aktualisierte Dokument zurück — nie nur den geänderten Abschnitt.\n\n## Wichtige Regeln:\n- Immer das vollständige Dokument ausgeben\n- In sauberem Markdown formatieren\n- Kein Meta-Kommentar — nur den Dokumentinhalt zurückgeben"
  },
  "greeting": {
    "en": {
      "title": "Dictation Writer",
      "subtitle": "Click the **microphone** and describe what you want to create — an email, blog post, report, or anything else. I'll generate the document and you can keep refining it with your voice."
    },
    "de": {
      "title": "Diktat-Schreiber",
      "subtitle": "Klicke auf das **Mikrofon** und beschreibe, was du erstellen möchtest. Ich generiere das Dokument und du kannst es mit deiner Stimme weiter verfeinern."
    }
  },
  "starterPrompts": [
    {
      "title": { "en": "Email", "de": "E-Mail" },
      "message": { "en": "Write an email to ", "de": "Schreibe eine E-Mail an " },
      "description": { "en": "Start an email draft", "de": "E-Mail-Entwurf beginnen" },
      "autoSend": false
    },
    {
      "title": { "en": "Blog Post", "de": "Blogbeitrag" },
      "message": { "en": "Write a blog post about ", "de": "Schreibe einen Blogbeitrag über " },
      "description": { "en": "Create a blog post", "de": "Blogbeitrag erstellen" },
      "autoSend": false
    },
    {
      "title": { "en": "Meeting Notes", "de": "Besprechungsprotokoll" },
      "message": { "en": "Create meeting notes for ", "de": "Erstelle ein Besprechungsprotokoll für " },
      "description": { "en": "Structure meeting notes", "de": "Besprechungsnotizen strukturieren" },
      "autoSend": false
    },
    {
      "title": { "en": "Report", "de": "Bericht" },
      "message": { "en": "Write a report about ", "de": "Schreibe einen Bericht über " },
      "description": { "en": "Create a structured report", "de": "Strukturierten Bericht erstellen" },
      "autoSend": false
    }
  ],
  "messagePlaceholder": {
    "en": "Describe what you want to create, or how to modify the document...",
    "de": "Beschreibe, was du erstellen möchtest, oder wie das Dokument geändert werden soll..."
  },
  "settings": {
    "enabled": true,
    "model": { "enabled": true },
    "temperature": { "enabled": true },
    "outputFormat": { "enabled": false }
  },
  "enabled": true
}
```

**Note on `features` flag naming:** The `app?.features?.canvas === true` check (used in `AppChat.jsx` and `SharedAppHeader.jsx`) requires `canvas` to stay a boolean. The autoApply flag is stored as a sibling: `features.canvasAutoApply: true`. The featuresSchema uses `.passthrough()` so this is accepted without a schema change. In the app config JSON, use:
```json
"features": {
  "canvas": true,
  "canvasAutoApply": true
}
```
The client reads it as `app?.features?.canvasAutoApply === true`.

## Architecture Summary

```
User dictates brief (chat view, mic in manual mode)
        ↓
LLM generates document (response > 200 chars)
        ↓
Auto-redirect to canvas, chatId carried over
  Content written to sessionStorage, not URL
        ↓
Canvas loads, reads content from sessionStorage
  Applies to Quill editor
  Chat history preserved (same chatId)
        ↓
User views document in Quill editor
  Option A: Manual edit (keyboard/mouse)
  Option B: Dictate into editor (CanvasVoiceInput toolbar button)
  Option C: Dictate instruction to LLM (chat panel mic, NEW)
        ↓
LLM receives: instruction + full document context
        ↓
LLM returns full updated document
        ↓
autoApply: content automatically replaces editor  ← NEW
(no manual "Insert" click required)
        ↓
User continues refining or exports
```

## Files to Modify

| File | Change |
|------|--------|
| `client/src/features/canvas/pages/AppCanvas.jsx` | Fix `bypassAppPrompts`, add `autoApply` effect, full doc context, read chatId from URL, read content from sessionStorage |
| `client/src/features/apps/pages/AppChat.jsx` | Write content to sessionStorage instead of URL, pass chatId on redirect |
| `client/src/features/canvas/components/CanvasChatPanel.jsx` | Wire real `onVoiceInput` handler |

## Files to Create

| File | Purpose |
|------|---------|
| `contents/apps/dictation-writer.json` | New app config |

## Verification

1. Navigate to the dictation-writer app
2. Click microphone, dictate "Write a short email to my boss saying I'll be 30 minutes late tomorrow"
3. Verify: auto-redirect fires and canvas opens with the email in the editor, chat history preserved
4. Dictate in the chat panel: "Make the tone more formal"
5. Verify: editor content updates automatically (autoApply), no manual Insert click needed
6. Manually edit a word in the editor
7. Dictate: "Add a PS at the bottom saying I'll bring coffee"
8. Verify: LLM uses full document context and appends PS, preserving manual edits
9. Verify: FloatingToolbox (expand, condense, etc.) still works via text selection
10. Verify: Export menu (copy as text/markdown, print PDF) works
11. Open a new chat from the header and dictate a completely different document type
12. Verify: voice transcript overlay shows during recording
