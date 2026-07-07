// Pure, dependency-free helpers for interpreting Outlook attachment
// descriptors (as produced by outlookMailContext.js's readMailSnapshot).
// Kept separate from buildChatApiMessages.js — which pulls in the full
// document-processing pipeline (pdf.js, mammoth, xlsx, ...) — so this
// logic can be unit tested directly under plain node without a bundler.
// See issue #1451.

/**
 * Strip MIME-type parameters so e.g. `image/jpeg; name="foo.jpg"` collapses to
 * `image/jpeg`. Outlook (and some Exchange servers) decorate the contentType
 * with a `name=` parameter which the LLM adapters then send as the `media_type`
 * — Anthropic rejects anything that isn't a bare MIME type, so without this
 * step image attachments fail before the model ever sees them.
 */
export function sanitizeContentType(ct) {
  if (!ct || typeof ct !== 'string') return '';
  return ct.split(';')[0].trim().toLowerCase();
}

/**
 * True only when the attachment's `content` blob carries actual binary
 * data. Outlook's `getAttachmentContentAsync` can return four formats —
 * `Base64`, `Eml`, `iCalendar`, `Url` — and only `base64` is usable as an
 * image / file payload. Cloud attachments (OneDrive / SharePoint links)
 * arrive as `format: 'url'` with `content` set to the share link, which
 * we previously fed straight into `atob()` and shipped to the LLM as if
 * it were base64. That was the silent failure path behind issue #1467.
 */
export function hasBase64Content(att) {
  if (!att?.content) return false;
  const fmt = String(att.content.format || '').toLowerCase();
  // Office.js returns the enum value verbatim; treat anything other
  // than the explicit "base64" string as non-base64 to be safe.
  if (fmt && fmt !== 'base64') return false;
  return typeof att.content.content === 'string' && att.content.content.length > 0;
}
