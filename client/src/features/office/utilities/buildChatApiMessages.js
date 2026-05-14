import { processDocumentFile } from '../../upload/utils/fileProcessing';

export function createUserMessageId() {
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function isImageAttachment(att) {
  if (!att) return false;
  const ct = (att.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return true;
  const name = (att.name || '').toLowerCase();
  return IMAGE_EXT.test(name);
}

export function buildImageDataFromMailAttachments(attachments) {
  if (!attachments?.length) return null;
  const images = attachments.filter(isImageAttachment).filter(a => a.content && !a.error);
  if (!images.length) return null;
  // Map to the shape the server adapters expect: { base64, fileType }
  return images.map(a => ({
    source: 'local',
    base64: a.content.content,
    fileType: a.contentType,
    fileName: a.name,
    fileSize: a.size
  }));
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
export async function buildFileDataFromMailAttachments(attachments) {
  if (!attachments?.length) return null;
  const files = attachments.filter(a => !isImageAttachment(a)).filter(a => a.content && !a.error);
  if (!files.length) return null;

  const results = await Promise.all(
    files.map(async a => {
      try {
        const file = base64ToFile(a.content.content, a.name, a.contentType);
        const { content, pageImages } = await processDocumentFile(file);
        return {
          source: 'local',
          fileName: a.name,
          fileType: a.contentType,
          displayType: a.contentType,
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
