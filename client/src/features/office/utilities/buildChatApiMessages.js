import { processDocumentFile, resizeImageCanvas } from '../../upload/utils/fileProcessing';
import { sanitizeContentType, hasBase64Content } from './attachmentFormat';
import { parseEmlAttachment, parseIcsAttachment } from './emailAttachmentParsers';

export { sanitizeContentType, hasBase64Content };

export function createUserMessageId() {
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
// Cap at 1024px and re-encode as JPEG at 80% quality via the shared
// resizeImageCanvas primitive. Phone-camera JPGs embedded in emails can be
// 4–5 MB which exceeds the per-image limits on some vision models (e.g.
// Anthropic 5 MB). Without this normalization those messages silently fail
// on the provider side — see issue #1467.
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_REENCODE_QUALITY = 0.8;

/** Human-readable "name (content type)" used in skip/failure log lines. */
function describeAttachment(att) {
  const contentType = sanitizeContentType(att?.contentType) || att?.contentType || 'unknown type';
  return `"${att?.name || 'unnamed'}" (${contentType})`;
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

    const { dataUrl } = resizeImageCanvas(img, maxDimension, IMAGE_REENCODE_QUALITY);
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

// Builds the { fileName, fileType, displayType, content?, pageImages? }
// entry (shape RequestBuilder.preprocessMessagesWithFileData expects) for a
// single non-image attachment, dispatching on the content format Office
// actually returned rather than assuming everything is a binary document:
// - `eml` (attached/forwarded emails) and `icalendar` (meeting invites) are
//   textual formats — parsed directly into readable content.
// - `url` (OneDrive/SharePoint share links) has no file bytes to read, so
//   the link itself is sent as a reference instead of being dropped.
// - anything else goes through the shared binary-document pipeline.
async function buildFileEntryForAttachment(a) {
  const format = String(a?.content?.format || '').toLowerCase();
  const cleanType =
    sanitizeContentType(a.contentType) || a.contentType || 'application/octet-stream';

  if (format === 'eml') {
    const text = parseEmlAttachment(a.content.content);
    if (!text) {
      console.warn(`[office] attachment ${describeAttachment(a)} could not be parsed as an email`);
      return null;
    }
    return {
      source: 'local',
      origin: 'attachment',
      fileName: a.name,
      fileType: 'message/rfc822',
      displayType: 'Email',
      content: text
    };
  }

  if (format === 'icalendar') {
    const text = parseIcsAttachment(a.content.content);
    if (!text) {
      console.warn(`[office] attachment ${describeAttachment(a)} could not be parsed as an invite`);
      return null;
    }
    return {
      source: 'local',
      origin: 'attachment',
      fileName: a.name,
      fileType: 'text/calendar',
      displayType: 'Calendar invite',
      content: text
    };
  }

  if (format === 'url') {
    // Office only exposes the share link for cloud attachments, not the
    // file bytes — there's nothing to extract, but the link is still
    // useful context, so it's sent instead of silently dropping the
    // attachment (previously fed straight into atob() as if it were
    // base64 — see issue #1467).
    return {
      source: 'local',
      origin: 'attachment',
      fileName: a.name,
      fileType: cleanType,
      displayType: cleanType,
      content: `[Cloud-hosted attachment — content was not retrieved. Link: ${a.content.content}]`
    };
  }

  if (!hasBase64Content(a)) {
    console.warn(`[office] attachment ${describeAttachment(a)} has an unrecognized content format`);
    return null;
  }

  try {
    const file = base64ToFile(a.content.content, a.name, cleanType);
    const { content, pageImages } = await processDocumentFile(file);
    return {
      source: 'local',
      origin: 'attachment',
      fileName: a.name,
      fileType: cleanType,
      displayType: cleanType,
      content: content || undefined,
      pageImages: pageImages?.length ? pageImages : undefined
    };
  } catch (err) {
    console.warn(
      `[office] attachment ${describeAttachment(a)} could not be converted to text and was skipped`,
      err
    );
    return null;
  }
}

// Processes non-image attachments into file data for the outgoing request.
// Returns an array of { fileName, fileType, displayType, content?, pageImages? }.
export async function buildFileDataFromMailAttachments(attachments) {
  if (!attachments?.length) return null;
  const candidates = attachments
    .filter(a => !a?.isInline)
    .filter(a => !isImageAttachment(a))
    .filter(a => !a.error)
    .filter(a => a?.content?.content);
  if (!candidates.length) return null;

  const results = await Promise.all(candidates.map(buildFileEntryForAttachment));
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

/**
 * `{ name, email }` → "Name (email)", or whichever part exists. Parentheses
 * rather than the RFC 5322 "Name <email>" form so no stray angle brackets end
 * up inside the tagged blocks.
 */
function formatIdentity(person) {
  if (!person) return '';
  const name = (person.name || '').trim();
  const email = (person.email || '').trim();
  if (name && email && name !== email) return `${name} (${email})`;
  return name || email;
}

function formatIdentityList(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.map(formatIdentity).filter(Boolean).join(', ');
}

/** An ISO timestamp in the user's locale and time zone, which the server does not know. */
function formatIsoForPrompt(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch {
    return iso;
  }
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

/** Drop empty fields so the wire object only carries what the host delivered. */
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) if (value) out[key] = value;
  return Object.keys(out).length ? out : null;
}

function emailFields(email) {
  return {
    from: formatIdentity(email?.from),
    to: formatIdentityList(email?.to),
    cc: formatIdentityList(email?.cc),
    date: formatIsoForPrompt(email?.dateTimeCreated),
    subject: text(email?.subject)
  };
}

/**
 * The current Outlook email — or, in the browser extension, the active tab.
 * Email headers ride along even when the user excluded the body via the
 * context strip: the strip still shows the subject, and a reply has to know
 * who it is answering. A page without text is dropped entirely; its title and
 * URL are not context on their own.
 */
function currentItemContext(item) {
  if (!item || item.available === false) return {};
  if (item.itemKind === 'page') {
    const body = text(item.bodyText);
    if (!body) return {};
    return { currentPage: compact({ title: text(item.title), url: text(item.url), body }) };
  }
  if (item.itemKind === 'appointment') {
    const start = formatIsoForPrompt(item.start);
    const end = formatIsoForPrompt(item.end);
    const meeting = compact({
      subject: text(item.subject),
      yourRole: item.isOrganizer ? 'Organizer' : item.organizer?.email ? 'Attendee' : '',
      when: start && end ? `${start} – ${end}` : start,
      location: text(item.location),
      organizer: formatIdentity(item.organizer),
      requiredAttendees: formatIdentityList(item.requiredAttendees),
      optionalAttendees: formatIdentityList(item.optionalAttendees),
      description: text(item.bodyText)
    });
    return meeting ? { currentMeeting: meeting } : {};
  }
  const email = compact({
    ...emailFields(item),
    mailboxUser: formatIdentity(item.mailboxUser),
    body: text(item.bodyText)
  });
  return email ? { currentEmail: email } : {};
}

/**
 * Emails the user pinned or bulk-selected, de-duplicated against each other
 * and against the current item.
 */
function addedEmailsContext(pinned, currentItemId) {
  const list = Array.isArray(pinned) ? pinned : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const id = p?.itemId;
    if (id && currentItemId && id === currentItemId) continue;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (!text(p?.subject) && !text(p?.bodyText)) continue;
    out.push(compact({ ...emailFields(p), body: text(p?.bodyText) }));
  }
  return out.length ? { addedEmails: out } : {};
}

/**
 * The host item the user is looking at, as the `hostContext` field of the
 * outgoing user message. The server renders it — with uploads and email
 * attachments — as tagged blocks around what the user typed
 * (shared/promptContext.js); the client only picks the values and formats
 * them for display (names, dates in the user's locale). Returns null when
 * there is nothing to send.
 *
 * @param {Object} args
 * @param {Object|null} args.item          Host context of the current item: the
 *                                         snapshot from `readMessageContext`
 *                                         (email, `itemKind: 'page'` or
 *                                         `'appointment'`), with the user's body
 *                                         opt-out and attachment removals applied.
 * @param {string|null} [args.currentItemId] itemId of the current item — used to
 *                                         dedupe `pinned` against it.
 * @param {Array} [args.pinned]            Emails the user explicitly attached.
 * @returns {Object|null}
 */
export function buildHostContext({ item, currentItemId, pinned }) {
  const context = {
    ...addedEmailsContext(pinned, currentItemId ?? item?.itemId ?? null),
    ...currentItemContext(item)
  };
  return Object.keys(context).length ? context : null;
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
