# 05 — Word Add-in and Tools

**Phase:** P4 (needs P1, P3)
**Parent:** [README](README.md)

## Goal

In Word the user can:
- chat about the document and the selection
- have the model improve, translate, shorten or restructure text
- work with comments and tracked changes

Edits are **tracked changes by default**, so every change can be reviewed in Word itself.

## Host adapter (`client/src/features/office/hosts/word.js`)

- **`readMessageContext()`** returns `hostContext` `type:"document"`:
  - the selection (`context.document.getSelection()`, `text`)
  - the outline (paragraphs with built-in heading styles)
  - optionally the body text (`context.document.body.text`, capped)
- **Toggles:** *Include selection* (on) and *Include whole document* (off).
- **Insert action:** replace the selection, or insert after it when the selection is empty. Markdown is converted with `renderMarkdown` (`client/src/config/marked.config.js`, DOMPurify-sanitized), never bare `marked.parse`, then filtered by a document allowlist (no `script`, `style`, `iframe`, `form`, event attributes, `javascript:`/`data:` links) and inserted with `insertHtml`.
- **No item-change event.** The document is fixed for the pane's lifetime. The advertised target is `documentId`: the document URL, or a session id for an unsaved document ([01](01-client-executed-tools.md#executing-in-the-pane)).

## Tool set (v1)

| Tool | Word API | Min WordApi | Approval |
|---|---|---|---|
| `getSelectionContext` | selection + enclosing paragraph(s) + nearest heading | 1.3 | never |
| `getDocumentOutline` | paragraphs with `styleBuiltIn` Heading1–9 | 1.3 | never |
| `getParagraphs` | `body.paragraphs`, by range `{from, count}`, capped per call | 1.3 | never |
| `searchDocument` | `body.search(text, options)` → ranges with context | 1.3 | never |
| `listComments` | `body.getComments()` | 1.4 | never |
| `insertText` | `insertHtml` at the cursor or after a paragraph | 1.3 | never when tracked; **always** when untracked |
| `replaceSelection` | `selection.insertHtml(…, 'Replace')` | 1.3 | never (tracked) / **always** (untracked) |
| `findAndReplace` | `search` + `insertText(…, 'Replace')` on each hit, max *n* | 1.3 | **always** |
| `applyStyle` | `paragraph.styleBuiltIn` / `style` | 1.3 | never when tracked; **always** when untracked |
| `replyToComment` / `resolveComment` | `comment.reply()` / `comment.resolved = true` | 1.4 | **always** (changes shared collaboration state that co-authors see; not covered by Track Changes) |
| `insertTable` | `insertTable(rows, cols, …, values)` | 1.3 | never when tracked; **always** when untracked |
| `listTrackedChanges` | `body.getTrackedChanges()` | 1.6 | never |

### Tracked changes

- **Switching on.** Before each write, the executor reads the user's `changeTrackingMode` and sets `Word.ChangeTrackingMode.trackAll` (WordApi 1.4).
- **Restoring, including on failure.** The previous mode is restored in a `finally` block, so a rejected write or a rejected `context.sync()` never leaves `trackAll` switched on for the user's own later edits. If the restore itself fails, the pane shows a notice telling the user that Track Changes was left on.
- **Setting.** The default comes from `officeIntegration.hosts.word.trackChanges` (`on` | `off` | `user`), and the user can override it in the pane's Settings dialog.
- **Fallback.** On clients without WordApi 1.4 the writes are plain, and the activity row says so.
- **Approval for untracked writes.** When writes are *not* tracked, because the setting is `off` or WordApi 1.4 is missing, **every** Word write needs approval: `insertText`, `replaceSelection`, `applyStyle`, `insertTable` and `findAndReplace`. The approval seam reads the tracking state the pane advertised with the turn; the pane re-checks it before the write.
- **Why tracked writes are exempt.** A tracked change is itself a review step: it stays visible in Word until the user accepts or rejects it. Comment replies and resolutions are not tracked, so they always ask.

### Limits

- `getParagraphs` returns at most 200 paragraphs or 50,000 characters per call, whichever comes first. The model pages through with `from`.
- `findAndReplace` changes at most 200 hits per call. It previews them in the approval card (first 20).

## Ribbon (pane handoff, see [04](04-host-foundation.md#ribbon-commands))

| Button | Action prompt (configurable) |
|---|---|
| Improve | read the selection with `getSelectionContext`, improve clarity, apply with `replaceSelection` |
| Translate | translate the selection to the user's chosen language, apply with `replaceSelection` |
| Summarize | summarize the selection or document in the chat; no writes |

## Default app

`word-assistant` under `server/defaults/apps/` grants the Word integration. Its prompt prefers tracked edits and small edits over whole-document rewrites.

Related: `create_docx` (`server/systemSkills/docx`, `server/services/documents/docx/`) stays the way to *generate* a new document. These tools edit the open one.

## Tests

- **Executor unit tests** against a Word.js mock:
  - tracked-mode on and restored after a successful write
  - tracked-mode restored after a **rejected** write and after a rejected `context.sync()`
  - untracked mode: every write tool raises an approval; tracked mode: only `findAndReplace` and the comment tools do
  - paging caps
  - the `findAndReplace` cap and preview
  - hostile model output (`<script>`, `<img onerror>`, `<iframe>`, `[x](javascript:…)`) is inserted without any of it
- **Manual matrix:** Word for the web, Word for Windows (Microsoft 365) and Word for Mac; WordApi 1.3 vs 1.5 behavior.

## Acceptance criteria

- "Improve this paragraph" yields a tracked change and no other edits.
- "Replace *Kunde* with *Auftraggeber* throughout" shows an approval with the hit count and a preview, then applies tracked changes.
- The model can answer questions about a 100-page document by paging through `getDocumentOutline` and `getParagraphs`, without the whole text being sent at once.
