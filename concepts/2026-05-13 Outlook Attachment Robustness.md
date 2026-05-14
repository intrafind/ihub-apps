# Outlook Attachment Robustness (PDF / Word / .eml)

**Date:** 2026-05-13
**Issue:** [#1451](https://github.com/intrafind/ihub-apps/issues/1451)
**Branch:** `claude/fix-issue-1451-Ew06p`

## Problem

Opening the Outlook add-in on emails containing PDF, Word, or `.eml`/`.msg`
attachments produced an error or silently dropped the attachment:

- `buildFileDataFromMailAttachments` fed **every** non-image attachment through
  `processDocumentFile` regardless of MIME type — `.msg`, `.eml`,
  encrypted PDFs, `.zip` etc. blew up inside the document pipeline.
- Failures were caught with `catch { return null }`, so the user lost the
  attachment without any feedback or log entry.
- `format: 'eml'` attachments (forwarded emails) are base64-encoded MIME
  messages — running them through `base64ToFile` + `processDocumentFile`
  was a guaranteed failure.
- The Mailbox API ≥ 1.8 check emitted one error per attachment instead of a
  single banner.

## Fix

### 1. Pre-filter by MIME / format

`classifyMailAttachment(att)` (new, in `buildChatApiMessages.js`) is the
single source of truth for "what should we do with this attachment?" It
returns one of:

| kind          | meaning                                            |
| ------------- | -------------------------------------------------- |
| `image`       | flows through `buildImageDataFromMailAttachments`  |
| `document`    | flows through `buildFileDataFromMailAttachments`   |
| `unsupported` | skipped on purpose (eml, unsupported MIME, no content) |
| `error`       | host already returned an error for this attachment |

A whitelist (`SUPPORTED_DOCUMENT_MIME_TYPES` + `SUPPORTED_DOCUMENT_EXTENSIONS`)
defines what counts as a document. `.eml` / `attachmentType === 'item'` is
explicitly excluded.

### 2. Surface failures to the user

`buildAttachmentStatuses(attachments)` returns a per-attachment status array
(`attached` / `unsupported` / `failed`) that the new
`MailAttachmentStatusBanner` renders above the chat input. The banner appears
in `OfficeChatPanel` and refreshes on `ihub:itemchanged`.

### 3. Structured error logs

Failures emit a single `console.error('[outlook] …', { fileName, contentType,
format, size, error })` line, so the existing client error reporter and
browser devtools have the attachment context to reproduce the failure.

### 4. Mailbox API ≥ 1.8 check upfront

`outlookMailContext.js` checks `getAttachmentContentAsync` availability once
before iterating descriptors. When the host doesn't support it, the returned
context carries `attachmentApiUnavailable: true` and the banner renders one
notice instead of one error per attachment.

### 5. `.eml` items skipped at the source

`attachmentType === 'item'` is now skipped during context fetch (no wasted
`getAttachmentContentAsync` call) and tagged with `skipped: true`,
`skipReason: 'eml'`, `skipMessage` — so the banner can show "Email items are
not yet supported as attachments." without losing the descriptor.

## Files changed

- `client/src/features/office/utilities/buildChatApiMessages.js` — new
  classifier + statuses, MIME whitelist, structured failure logging.
- `client/src/features/office/utilities/outlookMailContext.js` — single
  Mailbox-API-availability check, explicit `.eml` skip, structured per-attachment
  error log.
- `client/src/features/office/hooks/useMailAttachmentStatuses.js` (new) —
  loads statuses on mount + on `ihub:itemchanged`.
- `client/src/features/office/components/MailAttachmentStatusBanner.jsx` (new)
  — UI banner rendering ✓ attached / ⚠ unsupported / ✕ failed.
- `client/src/features/office/components/OfficeChatPanel.jsx` — wires the
  hook + banner above the chat input.
- `tests/unit/client/outlook-mail-attachments.test.jsx` (new) — 18 regression
  tests covering PDF / Word / .eml / oversized / unknown MIME, plus the
  combined repro scenario from the bug report.

## Acceptance criteria

- [x] Opening an email with PDF + Word + .eml attachments no longer throws or
      blocks the chat — `buildFileDataFromMailAttachments` resolves cleanly with
      just PDF + DOCX; `.eml` is reported as unsupported.
- [x] Each attachment renders with one of ✓ attached / ⚠ unsupported / ✕ failed
      in `MailAttachmentStatusBanner`.
- [x] Errors include the attachment name and content type in the client log.
- [x] Image attachments still flow through `buildImageDataFromMailAttachments`
      unchanged (covered by `extracts images and leaves documents alone`).
- [x] Regression test covers PDF, .docx, .eml, and an oversized / unknown-MIME
      attachment.

## Out of scope (follow-up)

- The richer "Review attachments" banner referenced in the issue lives in a
  separate ticket; the banner added here is the minimum surface area needed to
  satisfy the per-attachment status acceptance criterion.
- Server-side `.eml` decoding (extract subject / from / body and inline as
  quoted context) is deferred to a future change.
