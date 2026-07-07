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

// Formats getAttachmentContentAsync can return that this pipeline cannot
// turn into a file/image payload: `eml` (attached/forwarded email items),
// `icalendar` (meeting invites) and `url` (OneDrive/SharePoint share links,
// not binary data). These attachments fetch successfully — they have no
// `.error` — so without this check they looked "attached" in the review
// banner while `hasBase64Content` silently dropped them at send time. See
// issue #1451.
const UNSUPPORTED_CONTENT_FORMATS = new Set(['eml', 'icalendar', 'url']);

/**
 * True for an attachment that fetched successfully but is in a format this
 * pipeline doesn't convert to LLM-ready content. Distinct from `att.error`
 * (a fetch/network failure) so the UI can show "unsupported" instead of
 * "failed" for these.
 */
export function isUnsupportedAttachmentFormat(att) {
  if (!att?.content || att.error) return false;
  const fmt = String(att.content.format || '').toLowerCase();
  return UNSUPPORTED_CONTENT_FORMATS.has(fmt);
}
