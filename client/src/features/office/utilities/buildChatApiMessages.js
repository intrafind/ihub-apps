import { processDocumentFile } from '../../upload/utils/fileProcessing';

export function createUserMessageId() {
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
// Match ImageUploader: cap at 1024px and re-encode as JPEG at 80% quality.
// Phone-camera JPGs embedded in emails can be 4–5 MB which exceeds the
// per-image limits on some vision models (e.g. Anthropic 5 MB). Without
// this normalization those messages silently fail on the provider side
// — see issue #1467.
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_REENCODE_QUALITY = 0.8;

/**
 * Strip MIME-type parameters so e.g. `image/jpeg; name="foo.jpg"` collapses to
 * `image/jpeg`. Outlook (and some Exchange servers) decorate the contentType
 * with a `name=` parameter which the LLM adapters then send as the `media_type`
 * — Anthropic rejects anything that isn't a bare MIME type, so without this
 * step image attachments fail before the model ever sees them.
 */
function sanitizeContentType(ct) {
  if (!ct || typeof ct !== 'string') return '';
  return ct.split(';')[0].trim().toLowerCase();
}

export function isImageAttachment(att) {
  if (!att) return false;
  const ct = sanitizeContentType(att.contentType);
  if (ct.startsWith('image/')) return true;
  const name = (att.name || '').toLowerCase();
  return IMAGE_EXT.test(name);
}

/**
 * Resize a raw-base64 image down to `maxDimension` (longest edge) and
 * re-encode as JPEG at 80% quality. Returns the original base64 unchanged
 * if the image already fits, the format doesn't support canvas decode
 * (e.g. corrupted data), or anything throws during the round-trip. The
 * caller treats this as "best effort" — we'd rather send the original
 * image than drop it entirely.
 */
async function resizeImageBase64(base64Content, contentType, maxDimension) {
  if (!base64Content) return { base64: base64Content, contentType };
  let objectUrl = null;
  try {
    const binary = atob(base64Content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: contentType || 'image/jpeg' });
    objectUrl = URL.createObjectURL(blob);

    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image-load-failed'));
      im.src = objectUrl;
    });

    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) return { base64: base64Content, contentType };

    // No resize needed — image fits within the target box.
    if (Math.max(w0, h0) <= maxDimension) {
      return { base64: base64Content, contentType };
    }

    let width;
    let height;
    if (w0 >= h0) {
      width = maxDimension;
      height = Math.round((h0 * maxDimension) / w0);
    } else {
      height = maxDimension;
      width = Math.round((w0 * maxDimension) / h0);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { base64: base64Content, contentType };
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_REENCODE_QUALITY);
    const newBase64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
    return { base64: newBase64, contentType: 'image/jpeg' };
  } catch {
    return { base64: base64Content, contentType };
  } finally {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
    }
  }
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
function hasBase64Content(att) {
  if (!att?.content) return false;
  const fmt = String(att.content.format || '').toLowerCase();
  // Office.js returns the enum value verbatim; treat anything other
  // than the explicit "base64" string as non-base64 to be safe.
  if (fmt && fmt !== 'base64') return false;
  return typeof att.content.content === 'string' && att.content.content.length > 0;
}

/**
 * Build the imageData array sent to the LLM from a list of Outlook
 * attachments. Filters out inline images (HTML-signature logos, embedded
 * UI badges, etc.) so they don't silently bloat the request — they're
 * already hidden from the OfficeMailContextBanner UI for the same reason.
 * Image content-types are normalized and oversized images are resized to
 * fit the strictest vision-model limit (Anthropic, 5 MB / image). Cloud
 * attachments (format: 'url') are dropped because their `content` is a
 * share link, not binary data.
 */
export async function buildImageDataFromMailAttachments(attachments) {
  if (!attachments?.length) return null;
  const images = attachments
    .filter(a => !a?.isInline)
    .filter(isImageAttachment)
    .filter(hasBase64Content)
    .filter(a => !a.error);
  if (!images.length) return null;

  const processed = await Promise.all(
    images.map(async a => {
      const cleanType = sanitizeContentType(a.contentType) || 'image/jpeg';
      const { base64, contentType } = await resizeImageBase64(
        a.content.content,
        cleanType,
        IMAGE_MAX_DIMENSION
      );
      return {
        source: 'local',
        base64,
        fileType: contentType,
        fileName: a.name,
        fileSize: a.size
      };
    })
  );

  return processed.length ? processed : null;
}

function base64ToFile(base64, name, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], name, { type: contentType });
}

// Processes non-image attachments through the shared document pipeline.
// Returns an array of { fileName, fileType, displayType, content?, pageImages? }
// in the shape RequestBuilder.preprocessMessagesWithFileData expects.
// Skips cloud attachments (format: 'url') and EML / iCalendar items since
// the document pipeline expects binary file bytes — see `hasBase64Content`.
export async function buildFileDataFromMailAttachments(attachments) {
  if (!attachments?.length) return null;
  const files = attachments
    .filter(a => !a?.isInline)
    .filter(a => !isImageAttachment(a))
    .filter(hasBase64Content)
    .filter(a => !a.error);
  if (!files.length) return null;

  const results = await Promise.all(
    files.map(async a => {
      try {
        const cleanType =
          sanitizeContentType(a.contentType) || a.contentType || 'application/octet-stream';
        const file = base64ToFile(a.content.content, a.name, cleanType);
        const { content, pageImages } = await processDocumentFile(file);
        return {
          source: 'local',
          fileName: a.name,
          fileType: cleanType,
          displayType: cleanType,
          content: content || undefined,
          pageImages: pageImages?.length ? pageImages : undefined
        };
      } catch {
        return null;
      }
    })
  );

  const valid = results.filter(Boolean);
  return valid.length ? valid : null;
}

/**
 * Merge the current Outlook item's attachments with attachments harvested
 * from emails the user has pinned (via "Add this email" / multi-select).
 * Pinned items whose itemId matches the current item are skipped so the
 * same attachments aren't sent twice.
 */
export function collectAttachmentsForSend(currentAttachments, pinnedEmails, currentItemId) {
  const current = Array.isArray(currentAttachments) ? currentAttachments : [];
  const pinned = Array.isArray(pinnedEmails) ? pinnedEmails : [];
  if (pinned.length === 0) return current;

  const merged = [...current];
  for (const p of pinned) {
    if (p?.itemId && currentItemId && p.itemId === currentItemId) continue;
    const list = Array.isArray(p?.attachments) ? p.attachments : [];
    if (list.length === 0) continue;
    merged.push(...list);
  }
  return merged;
}

export function combineUserTextWithEmailBody(userText, emailBodyText) {
  const u = (userText || '').trim();
  const e = (emailBodyText || '').trim();
  if (!e) return u;
  if (!u) return `--- Current email ---\n${e}`;
  return `${u}\n\n--- Current email ---\n${e}`;
}

function formatPinnedEmail(p, idx) {
  const subject = (p?.subject || '').trim();
  const body = (p?.bodyText || '').trim();
  const header = `[${idx + 1}]${subject ? ` Subject: ${subject}` : ''}`;
  return body ? `${header}\n${body}` : header;
}

/**
 * Stitch user text together with the current Outlook mail item and any
 * pinned-from-other-emails context. Output shape stays identical to
 * `combineUserTextWithEmailBody` when `pinned` is empty so the
 * single-email flow is a strict no-op regression-wise.
 *
 * @param {Object}    args
 * @param {string}    args.userText                 What the user typed.
 * @param {string|null} args.currentBodyText        Body of Office.context.mailbox.item
 *                                                  (already stripped by the user's
 *                                                  context-toggle if they turned it off).
 * @param {string|null} [args.currentItemId]        itemId of the current Outlook item —
 *                                                  used to dedupe against pinned[].
 * @param {Array<{subject?: string, bodyText?: string|null, itemId?: string|null}>} [args.pinned]
 *                                                  Emails the user explicitly attached to this
 *                                                  message (pin/collect mode, or bulk-pulled via
 *                                                  native multi-select).
 */
export function combineUserTextWithEmailContext({
  userText,
  currentBodyText,
  currentItemId,
  pinned
}) {
  const list = Array.isArray(pinned) ? pinned : [];
  if (list.length === 0) {
    return combineUserTextWithEmailBody(userText, currentBodyText);
  }

  const u = (userText || '').trim();
  const seen = new Set();
  const dedupedPinned = [];
  for (const p of list) {
    const id = p?.itemId;
    if (id && currentItemId && id === currentItemId) continue;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (!(p?.subject || '').trim() && !(p?.bodyText || '').trim()) continue;
    dedupedPinned.push(p);
  }

  const segments = [];
  if (u) segments.push(u);

  if (dedupedPinned.length > 0) {
    const pinnedBlock = dedupedPinned.map((p, i) => formatPinnedEmail(p, i)).join('\n\n');
    segments.push(`--- Pinned emails (${dedupedPinned.length}) ---\n${pinnedBlock}`);
  }

  const currentBody = (currentBodyText || '').trim();
  if (currentBody) {
    segments.push(`--- Current email ---\n${currentBody}`);
  }

  return segments.join('\n\n');
}

export function buildPromptTemplate(selectedStarterPrompt, selectedApp) {
  const fromPromptObject = p => {
    if (!p || typeof p !== 'object') return null;
    const en = typeof p.en === 'string' ? p.en : '';
    const de = typeof p.de === 'string' ? p.de : '';
    if (!en.trim() && !de.trim()) return null;
    return { en, de };
  };

  const fromPrompt =
    fromPromptObject(selectedStarterPrompt?.prompt) || fromPromptObject(selectedApp?.prompt);
  if (fromPrompt) return fromPrompt;

  const sys = selectedStarterPrompt?.system || selectedApp?.system || {};
  return {
    en: typeof sys.en === 'string' ? sys.en : '',
    de: typeof sys.de === 'string' ? sys.de : ''
  };
}

export function buildMinimalApiMessage(m) {
  return {
    role: m.role,
    content: m.content,
    messageId: `msg-hist-${m.id}`,
    promptTemplate: null,
    variables: {},
    audioData: null,
    fileData: null,
    imageData: null
  };
}

export function buildRichUserApiMessage(p) {
  const {
    role = 'user',
    content,
    messageId,
    promptTemplate,
    variables = {},
    audioData = null,
    fileData = null,
    imageData = null
  } = p;
  return {
    role,
    content,
    messageId,
    promptTemplate,
    variables,
    audioData,
    fileData,
    imageData
  };
}

export function threadToApiMessages(thread, richLastUserMessage) {
  if (!thread.length) return [];
  return thread.map((m, index) => {
    const isLast = index === thread.length - 1;
    if (isLast && m.role === 'user') {
      return richLastUserMessage;
    }
    return buildMinimalApiMessage(m);
  });
}
