# Fix: Answer is based on AI knowledge even if content is uploaded

**Issue:** #1672  
**Date:** 2026-07-06  
**Status:** Fixed

## Problem

When a user uploads a document in an app that uses a prompt template with a `{{content}}`
placeholder (e.g. the Summarizer app), the AI ignored the uploaded file and answered from
its own knowledge or said "there is nothing to summarize."

## Root Cause

`PromptService.processMessageTemplates` processes message templates **before**
`RequestBuilder.preprocessMessagesWithFileData` prepends the uploaded file text.

When building the `{{content}}` template variable, the code used only `msg.content`
(the user's typed text), not the uploaded file content stored in `msg.fileData.content`.

### Example (Summarizer app)

**Template:** `"Please {{action}} the following content: \"{{content}}\""`

**With an uploaded PDF and empty user text:**

| Step | Result |
|------|--------|
| `processMessageTemplates` | `"Please summarize the following content: \"\""` |
| `preprocessMessagesWithFileData` | `"[File: doc.pdf]\n\nDoc content...\n\nPlease summarize the following content: \"\""` |

The AI received an explicit instruction to summarize *empty* content, while the document
floated before the instruction with no explicit connection to the `{{content}}` placeholder.

## Fix

### `server/services/PromptService.js` (`processMessageTemplates`)

Before building the `variables` object for template substitution, check whether the
message has `fileData` with text content:

- **Single file:** `msg.fileData.content` is truthy → prepend
  `[File: filename (type)]\n\ncontent\n\n` to `contentForTemplate`.
- **Multiple files (array):** iterate `msg.fileData`, collect items with `.content`,
  join them all.
- Set `fileContentInjected = true` and use `contentForTemplate` as `variables.content`.
- After template expansion, attach `_fileContentInjectedViaTemplate = true` marker to the
  processed message.
- The "ensure content is always included" fallback also uses `contentForTemplate` (not just
  `msg.content`) when `fileContentInjected` is true, so templates **without** `{{content}}`
  also receive the file text.

### `server/services/chat/RequestBuilder.js` (`preprocessMessagesWithFileData`)

At the top of the `.map()` callback, check for the marker:

```js
if (msg._fileContentInjectedViaTemplate) {
  const { _fileContentInjectedViaTemplate: _, ...cleanMsg } = msg;
  return cleanMsg;   // file content already in the template — skip re-injection
}
```

This prevents the document from appearing twice in the LLM message.

## What is NOT affected

- **Image-based PDFs** (`msg.fileData.pageImages`, no `.content`): these are handled
  separately as `imageData` by `preprocessMessagesWithFileData` and are unaffected.
- **Direct image uploads** (`msg.imageData`): unaffected.
- **Apps without prompt templates**: the normal `preprocessMessagesWithFileData` path
  still runs as before — no marker is set, so file content is prepended normally.
- **Knowledge-source badge** ("Based on uploaded file" vs "Based on AI knowledge"):
  `fileData` is preserved on the processed message via the spread operator, so the
  detection logic in `StreamingHandler` and `ToolExecutor` continues to work correctly.

## Files Changed

- `server/services/PromptService.js` — inject file content into `{{content}}` variable
- `server/services/chat/RequestBuilder.js` — skip double-injection via marker

## Tests Added

`tests/unit/server/promptService-file-content.test.js` — 9 unit tests covering:

1. Single file text injected into `{{content}}`
2. `_fileContentInjectedViaTemplate` marker set when file content injected
3. Marker NOT set for image-based PDFs (no `.content`)
4. Marker NOT set when no `fileData`
5. Multiple files combined into `{{content}}`
6. User-typed text preserved after file content
7. `fileData` preserved on processed message for knowledge-source tracking
8. No content duplication when template has no `{{content}}` placeholder
9. Image-only array entries ignored; text-only entries still injected
