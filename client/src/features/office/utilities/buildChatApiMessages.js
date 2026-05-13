import { processDocumentFile } from '../../upload/utils/fileProcessing';

export function createUserMessageId() {
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

// MIME types `processDocumentFile` can actually handle. Anything outside this
// list (e.g. .msg, application/octet-stream blobs, .zip, .eml) is treated as
// unsupported and surfaced to the user instead of being silently dropped.
const SUPPORTED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.ms-outlook',
  'application/x-msg',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html'
]);

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.msg',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.html',
  '.htm'
]);

export function isImageAttachment(att) {
  if (!att) return false;
  const ct = (att.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return true;
  const name = (att.name || '').toLowerCase();
  return IMAGE_EXT.test(name);
}

function getFileExtension(name) {
  if (!name || typeof name !== 'string') return '';
  const idx = name.lastIndexOf('.');
  if (idx < 0) return '';
  return name.slice(idx).toLowerCase();
}

/**
 * Classify how a mail attachment should be handled before we try to feed it
 * through `processDocumentFile`. Centralising this keeps the dispatcher in
 * `buildFileDataFromMailAttachments` simple and lets the UI render a status
 * per attachment without re-deriving the same logic.
 *
 * Returns one of:
 *   { kind: 'image' }                                    – goes to imageData
 *   { kind: 'document' }                                 – goes to fileData
 *   { kind: 'unsupported', reason, message }             – skipped, with reason
 *   { kind: 'error', message }                           – fetch already failed
 */
export function classifyMailAttachment(att) {
  if (!att) {
    return { kind: 'unsupported', reason: 'missing', message: 'No attachment data' };
  }
  if (att.skipped) {
    return {
      kind: 'unsupported',
      reason: att.skipReason || 'skipped',
      message: att.skipMessage || 'Attachment skipped.'
    };
  }
  if (att.error) {
    return { kind: 'error', message: att.error };
  }
  if (isImageAttachment(att)) {
    return { kind: 'image' };
  }
  if (att.attachmentType === 'item' || att.content?.format === 'eml') {
    return {
      kind: 'unsupported',
      reason: 'eml',
      message: 'Email attachments (.eml/.msg items) are not yet supported.'
    };
  }
  if (!att.content || typeof att.content.content !== 'string') {
    return {
      kind: 'unsupported',
      reason: 'no-content',
      message: 'Attachment has no readable content.'
    };
  }
  const mime = (att.contentType || '').toLowerCase();
  const ext = getFileExtension(att.name);
  if (SUPPORTED_DOCUMENT_MIME_TYPES.has(mime) || SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) {
    return { kind: 'document' };
  }
  return {
    kind: 'unsupported',
    reason: 'unsupported-type',
    message: `Unsupported file type: ${att.contentType || ext || 'unknown'}`
  };
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

function logAttachmentFailure(att, error) {
  const detail = {
    fileName: att?.name,
    contentType: att?.contentType,
    format: att?.content?.format,
    size: att?.size,
    error: error?.message ?? String(error)
  };
  // Structured console.error so the existing client error reporter and the
  // browser devtools both surface the failing attachment context.
  console.error('[outlook] attachment processing failed', detail);
}

// Processes non-image attachments through the shared document pipeline.
// Returns an array of { fileName, fileType, displayType, content?, pageImages? }
// in the shape RequestBuilder.preprocessMessagesWithFileData expects.
//
// Unsupported attachments and processing failures are NOT silently dropped —
// `buildAttachmentStatuses` exposes them to the UI so the user gets a clear
// "unsupported" / "failed" indicator instead of a missing attachment.
export async function buildFileDataFromMailAttachments(attachments) {
  if (!attachments?.length) return null;
  const documents = attachments.filter(a => classifyMailAttachment(a).kind === 'document');
  if (!documents.length) return null;

  const results = await Promise.all(
    documents.map(async a => {
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
      } catch (e) {
        logAttachmentFailure(a, e);
        return null;
      }
    })
  );

  const valid = results.filter(Boolean);
  return valid.length ? valid : null;
}

/**
 * Build a per-attachment status list for UI display. The same classification
 * runs as in `buildFileDataFromMailAttachments`, so the UI and the outgoing
 * apiMessage stay in sync about which attachments made it through.
 *
 * Returns an array of:
 *   { name, contentType, size, status: 'attached' | 'unsupported' | 'failed', message? }
 */
export function buildAttachmentStatuses(attachments) {
  if (!attachments?.length) return [];
  return attachments.map(a => {
    const classification = classifyMailAttachment(a);
    if (classification.kind === 'image' || classification.kind === 'document') {
      return {
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        status: 'attached'
      };
    }
    if (classification.kind === 'error') {
      return {
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        status: 'failed',
        message: classification.message
      };
    }
    return {
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      status: 'unsupported',
      reason: classification.reason,
      message: classification.message
    };
  });
}

export function combineUserTextWithEmailBody(userText, emailBodyText) {
  const u = (userText || '').trim();
  const e = (emailBodyText || '').trim();
  if (!e) return u;
  if (!u) return `--- Current email ---\n${e}`;
  return `${u}\n\n--- Current email ---\n${e}`;
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
