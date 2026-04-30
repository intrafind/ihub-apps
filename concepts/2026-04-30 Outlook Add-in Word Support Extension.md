# Outlook Add-in Word Support Extension

**Date:** 2026-04-30
**Status:** Concept
**Scope:** ihub-outlook-addin

## Problem Statement

The ihub-outlook-addin provides an AI chat assistant in Outlook's taskpane. Users want the same assistant available in Microsoft Word to work with document content instead of emails. ~60-70% of the codebase is already host-agnostic (auth, API services, UI components, routing). The Outlook-specific code is concentrated in ~10 files.

## Architecture: Host Context Provider Pattern

Introduce a `HostContext` — a strategy object created at startup based on `Office.context.host`. It's passed through React Context so any component can access host-specific behavior without prop drilling or scattered `if (host === "word")` checks.

```
Office.onReady(info) → createHostContext(info.host) → <HostContextProvider>
                                                           ↓
                                          useHostContext() in Chat, ChatMessage, Login
```

Each host adapter implements the same interface:
- `fetchDocumentContext()` — read current content (email body / document text)
- `insertContent(markdown)` — insert AI response (reply form / document body)
- `registerContentChangedHandler(cb)` — listen for context changes (email switch / n/a in Word)
- `getDefaultPrompts()` — host-appropriate starter prompts
- `getInsertButtonLabel()` — "Insert" vs "Insert into document"
- `getHostLabel()` — "Outlook" vs "Word" (for Login page copy)
- `getContextDescription()` — feature description for Login page
- `combineUserTextWithContext(userText, bodyText)` — format context separator

## Implementation Steps

### Step 1: Create Host Abstraction Layer (new files, no existing code changes)

**Create `src/taskpane/host/hostConstants.js`**
- Export `HOST_OUTLOOK = "outlook"`, `HOST_WORD = "word"`

**Create `src/taskpane/host/OutlookHostContext.js`**
- Wraps existing utilities — imports from `outlookMailContext.js` and `replyForm.js`
- `fetchDocumentContext()` → delegates to `fetchCurrentMailContext()`
- `insertContent(md)` → delegates to `displayReplyFormWithAssistantResponse(md)`
- `registerContentChangedHandler(cb)` → registers `Office.context.mailbox.addHandlerAsync(ItemChanged, cb)`
- `getDefaultPrompts()` → returns the 3 email-centric prompts currently in `Chat.jsx:45-67`
- `combineUserTextWithContext(userText, bodyText)` → uses `--- Current email ---` separator
- `getInsertButtonLabel()` → `"Insert"`
- `getHostLabel()` → `"Outlook"`
- `getContextDescription()` → `"Work with your mailbox context when an app needs the current email or attachments."`

**Create `src/taskpane/host/WordHostContext.js`**
- `fetchDocumentContext()` → uses `Word.run()` to load `context.document.body.text`, returns same shape `{ available, bodyText, subject: null, attachments: [] }`
  - Truncate to first 50,000 chars to avoid LLM context overflow
  - If text selection exists, prefer selected text over full body
- `insertContent(md)` → converts markdown to HTML via `marked.parse()`, uses `Word.run()` with `context.document.getSelection().insertHtml(html, Word.InsertLocation.after)`
- `registerContentChangedHandler(cb)` → returns no-op (Word has one document, no "item switch" concept)
- `getDefaultPrompts()` → returns Word-appropriate prompts: "Summarize this document", "Proofread this document", "What are the key points of this document?"
- `combineUserTextWithContext(userText, bodyText)` → uses `--- Current document ---` separator
- `getInsertButtonLabel()` → `"Insert into document"`
- `getHostLabel()` → `"Word"`
- `getContextDescription()` → `"Work with your document context when an app needs the current document content."`

**Create `src/taskpane/host/createHostContext.js`**
- Factory: `createHostContext(hostType)` returns `OutlookHostContext` / `WordHostContext` / fallback (defaults to Outlook behavior for backward compat)

**Create `src/taskpane/host/HostContextProvider.jsx`**
- React Context + Provider component
- Export `useHostContext()` hook

### Step 2: Wire Host Context into App Entry Point

**Modify `src/taskpane/index.jsx`**
- In `Office.onReady(info)`: detect host via `info.host`, call `createHostContext(info.host)`
- Wrap `<App>` in `<HostContextProvider value={hostContext}>`
- Remove the inline `Office.context.mailbox.addHandlerAsync(ItemChanged, ...)` block (moved into `OutlookHostContext`)
- Call `hostContext.registerContentChangedHandler(() => document.dispatchEvent(new CustomEvent("ihub:itemchanged")))` — preserves existing event mechanism

### Step 3: Update Chat Page to Use Host Context

**Modify `src/taskpane/pages/Chat.jsx`**
- Import `useHostContext` instead of `useOutlookMailContextReader`
- Replace `readMailContext` with `hostContext.fetchDocumentContext()`
- Replace hardcoded `DEFAULT_PROMPTS` (lines 45-67) with `hostContext.getDefaultPrompts()`
- Replace `combineUserTextWithEmailBody(content, mailCtx.bodyText)` with `hostContext.combineUserTextWithContext(content, mailCtx.bodyText)`
- `buildImageDataFromMailAttachments` / `buildFileDataFromMailAttachments` remain — they gracefully handle empty arrays (Word returns `attachments: []`)

### Step 4: Update ChatMessage Insert Button

**Modify `src/taskpane/components/chat/ChatMessage.jsx`**
- Import `useHostContext`
- Replace direct `displayReplyFormWithAssistantResponse(textToCopy)` call with `hostContext.insertContent(textToCopy)`
- Change button label from hardcoded `"Insert"` to `hostContext.getInsertButtonLabel()`
- Change title from `"Insert into reply"` to a generic label or derive from host context

### Step 5: Update Login Page Copy

**Modify `src/taskpane/pages/Login.jsx`**
- Import `useHostContext`
- Replace `"iHub Apps for Outlook"` (line 114) with `"iHub Apps for " + hostContext.getHostLabel()`
- Replace `"Use IntraFind iHub AI apps...directly inside Outlook."` (line 138-139) with host-adaptive text using `hostContext.getHostLabel()`
- Replace mailbox context description (lines 147-149) with `hostContext.getContextDescription()`

### Step 6: Update Commands Entry Point

**Modify `src/commands/commands.js`**
- Guard the Outlook-specific `notificationMessages` code with a check for `Office.context.mailbox`
- When running in Word, register a no-op or Word-appropriate command handler instead

### Step 7: Create Word Manifest

**Create `manifest-word.xml`** (project root)
- `xsi:type="TaskPaneApp"` (not `MailApp`)
- `<Host Name="Document"/>` (not `Mailbox`)
- `<Set Name="WordApi" MinVersion="1.3"/>` (WordApi 1.3 for body text + insertHtml + selection)
- `<Permissions>ReadWriteDocument</Permissions>`
- No `<FormSettings>` or `<Rule>` elements (Outlook-specific)
- VersionOverrides with `<ExtensionPoint xsi:type="PrimaryCommandSurface">` for ribbon button
- Same resource URLs pointing to `taskpane.html`, `commands.html`, and icons

**Rename `manifest.xml` → `manifest-outlook.xml`** (optional, for clarity)

### Step 8: Update Package Scripts

**Modify `package.json`**
- Add `"start:word"` and `"stop:word"` scripts referencing `manifest-word.xml`
- Add `"validate:word"` script
- Keep existing `start`/`stop` as aliases for Outlook (backward compat)

## Files Summary

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/taskpane/host/hostConstants.js` | Host type constants |
| Create | `src/taskpane/host/OutlookHostContext.js` | Outlook adapter (wraps existing utils) |
| Create | `src/taskpane/host/WordHostContext.js` | Word adapter (new Word.js API calls) |
| Create | `src/taskpane/host/createHostContext.js` | Factory function |
| Create | `src/taskpane/host/HostContextProvider.jsx` | React Context + useHostContext hook |
| Create | `manifest-word.xml` | Word-specific add-in manifest |
| Modify | `src/taskpane/index.jsx` | Host detection, provider wrapping |
| Modify | `src/taskpane/pages/Chat.jsx` | Use host context for prompts + content |
| Modify | `src/taskpane/components/chat/ChatMessage.jsx` | Use host context for insert |
| Modify | `src/taskpane/pages/Login.jsx` | Host-adaptive copy text |
| Modify | `src/commands/commands.js` | Guard Outlook-specific code |
| Modify | `package.json` | Add Word dev scripts |

**No changes needed** (reused as-is): all auth modules, API services, officeAuthDialog.js, locale.js, App.jsx, AppSelection.jsx, all UI components, webpack config, build tooling.

## Key Decisions

1. **Separate XML manifests** (not unified JSON) — the unified JSON manifest is not yet GA for Word. A `MailApp` and `TaskPaneApp` cannot coexist in one XML manifest per Microsoft docs.
2. **Single build, runtime host detection** — one webpack output serves both hosts. `Office.onReady(info)` provides `info.host` to select the right adapter. No build duplication.
3. **Strategy pattern over conditionals** — host-specific behavior lives in adapter objects, not scattered `if/else` checks. Clean, testable, extensible.
4. **Word reads selection first, falls back to full body** — avoids sending entire 100-page documents to the LLM when the user only cares about a paragraph.
5. **Existing Outlook code stays in place** — `outlookMailContext.js` and `replyForm.js` are not modified, just wrapped by `OutlookHostContext`. Zero regression risk for Outlook.

## Verification

1. **Build**: `npm run build` — should produce same output (single build)
2. **Outlook**: `npm run start` (or `start:outlook`) — verify all existing functionality works unchanged
3. **Word**: `npm run start:word` — verify:
   - Taskpane opens in Word's sidebar
   - Login flow works (same auth dialog)
   - Document text is read and sent as context
   - AI responses can be inserted into the document
   - Starter prompts show Word-appropriate text
   - Login page shows "iHub Apps for Word"
4. **Manifest validation**: `npm run validate:word` — should pass Office add-in manifest validation
