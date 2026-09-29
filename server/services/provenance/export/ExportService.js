/**
 * Server-side exports (concept §8.3; issues #2571, #2576).
 *
 * All exports are generated on the server, so they can be signed (the key
 * never reaches the browser) and so the browser print dialog — unreliable in
 * embedded hosts — is gone. The user selects the messages to export:
 *
 * - **stored chats**: the client sends message ids; the server loads the
 *   content, so the manifest vouches for exactly what iHub generated
 *   (`verified` when it matches the provenance record);
 * - **unstored chats**: the client sends the selected messages; each
 *   assistant message is compared with its provenance record (content hash).
 *   A match is `verified`; anything else — edited by the user, or unknown —
 *   is signed as `asserted` with action `c2pa.edited`. The manifest never
 *   claims more than the server can prove.
 * - **canvas / markdown viewer / workflow / artifact** documents are always
 *   `edited` ("AI-assisted, edited by user").
 *
 * @module services/provenance/export/ExportService
 */
import crypto from 'node:crypto';
import configCache from '../../../configCache.js';
import { getAppVersion } from '../../../utils/versionHelper.js';
import { getLocalizedContent } from '../../../../shared/localize.js';
import { DIGITAL_SOURCE_TYPES } from '../../../../shared/aiTransparency.js';
import { getAiTransparencyConfig, isAiTransparencyActive } from '../config.js';
import { getInstallationId, getInstallationUrl } from '../installation.js';
import provenanceStore, { hashContent } from '../ProvenanceStore.js';
import { signExport } from './ExportSigner.js';
import { signpostEnabled } from '../text/signpost.js';
import { EXPORT_FORMATS, renderExport } from './renderers/index.js';
import { getChatRepository } from '../../chat/ChatRepository.js';
import { authorizeChat } from '../../chat/chatAccess.js';

export const MAX_EXPORT_MESSAGES = 2000;
export const MAX_MESSAGE_CHARS = 500000;
const SOURCES = new Set(['chat', 'canvas', 'markdown', 'workflow', 'artifact']);

export class ExportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExportError';
    this.status = status;
  }
}

function newManifestId() {
  return `exp_${crypto.randomBytes(12).toString('base64url')}`;
}

function slug(text) {
  return (
    String(text || 'export')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .toLowerCase() || 'export'
  );
}

/**
 * Stored messages of a chat the caller may read, filtered to `messageIds`.
 */
async function loadStoredMessages(chatId, messageIds, user) {
  const repository = getChatRepository();
  if (!repository?.isAvailable?.()) throw new ExportError('Chat storage is not available', 503);
  const auth = await authorizeChat(chatId, user, { repository, intent: 'read' });
  if (!auth.ok || !auth.chat) throw new ExportError('Chat not found', 404);
  const { messages } = await repository.getMessages(chatId);
  const wanted = new Set(messageIds);
  const selected = messages.filter(
    m => wanted.has(m.id) || (m.clientMessageId && wanted.has(m.clientMessageId))
  );
  return { chat: auth.chat, messages: selected };
}

/**
 * How far the server vouches for one message.
 * @returns {Promise<{verification: string, contentId?: string, model?: string}>}
 */
async function verifyMessage(message, { stored, source }) {
  if (message.role !== 'assistant') return { verification: 'human' };
  if (source !== 'chat') return { verification: 'edited' };
  const record = await provenanceStore.findByContent(message.content || '');
  if (record) {
    return {
      verification: 'verified',
      contentId: record.contentId,
      model: record.model?.id || message.model || undefined
    };
  }
  // A stored message without a matching record predates provenance records
  // (or they expired): iHub stored it, but cannot prove it unchanged.
  return {
    verification: 'asserted',
    ...(stored && message.provenance?.contentId ? { contentId: message.provenance.contentId } : {}),
    ...(message.model ? { model: message.model } : {})
  };
}

function normalizeClientMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, MAX_EXPORT_MESSAGES).map((m, i) => ({
    id: typeof m?.id === 'string' ? m.id : undefined,
    role: ['user', 'assistant', 'system'].includes(m?.role) ? m.role : 'assistant',
    content: typeof m?.content === 'string' ? m.content.slice(0, MAX_MESSAGE_CHARS) : '',
    timestamp: typeof m?.timestamp === 'string' ? m.timestamp : undefined,
    model: typeof m?.model === 'string' ? m.model.slice(0, 200) : undefined,
    index: i
  }));
}

/**
 * Build, sign and record an export.
 *
 * @param {Object} request - validated request body
 * @param {string} request.format
 * @param {string} [request.appId]
 * @param {string} [request.chatId]
 * @param {string[]} [request.messageIds] - stored chats
 * @param {Object[]} [request.messages] - unstored chats and documents
 * @param {string} [request.title]
 * @param {Object} [request.settings]
 * @param {string} [request.source='chat']
 * @param {{template?: string, euIcon?: boolean, humanReviewed?: boolean}} [request.options]
 * @param {boolean} [request.single]
 * @param {Object} ctx
 * @param {Object} ctx.user
 * @param {string} [ctx.language]
 * @returns {Promise<{buffer: Buffer, mimeType: string, filename: string, manifestId: string, signed: boolean}>}
 */
export async function createExport(request, { user, language = 'en' }) {
  const format = request.format;
  if (!EXPORT_FORMATS.includes(format)) throw new ExportError(`Unknown export format ${format}`);
  const source = SOURCES.has(request.source) ? request.source : 'chat';
  const cfg = getAiTransparencyConfig();
  const active = isAiTransparencyActive();
  const apps = configCache.getApps(true)?.data || [];
  const app = request.appId ? apps.find(a => a.id === request.appId) || null : null;

  let messages;
  let stored = false;
  let chatTitle = null;
  if (request.chatId && Array.isArray(request.messageIds) && request.messageIds.length) {
    const loaded = await loadStoredMessages(
      request.chatId,
      request.messageIds.slice(0, MAX_EXPORT_MESSAGES),
      user
    );
    stored = true;
    chatTitle = loaded.chat?.title || null;
    messages = loaded.messages.map((m, i) => ({
      id: m.id,
      role: m.role,
      content: m.content || '',
      timestamp: m.ts,
      model: typeof m.model === 'string' ? m.model : m.provenance?.model?.id,
      provenance: m.provenance,
      index: i
    }));
  } else {
    messages = normalizeClientMessages(request.messages);
  }
  if (!messages.length) throw new ExportError('No messages selected for export');

  const verified = [];
  for (const m of messages) {
    verified.push({ ...m, ...(await verifyMessage(m, { stored, source })) });
  }

  const appName = app ? getLocalizedContent(app.name, language) || app.id : 'iHub Apps';
  const title = String(request.title || chatTitle || appName).slice(0, 200);
  const exportedAt = new Date().toISOString();
  const generator = `iHub Apps ${getAppVersion()}`;
  const provider = cfg.provider.legalEntity || null;
  const anyAi = verified.some(m => m.role === 'assistant');
  const anyEdited = verified.some(
    m => m.verification === 'asserted' || m.verification === 'edited'
  );
  const humanContent = verified.some(m => m.role === 'user');
  const euIcon =
    cfg.labels.euIcon === 'always' ||
    (cfg.labels.euIcon === 'optional' && request.options?.euIcon === true);
  const humanReviewed = request.options?.humanReviewed === true;
  const labelText =
    source === 'canvas' || source === 'markdown'
      ? 'AI-assisted content, edited by the user — created with iHub Apps'
      : 'AI-generated content — created with iHub Apps';

  const doc = {
    title,
    appName,
    exportedAt,
    language: language === 'de' ? 'de' : 'en',
    settings: request.settings && typeof request.settings === 'object' ? request.settings : null,
    messages: verified.map(
      ({ index, role, content, timestamp, model, verification, contentId }) => ({
        index,
        role,
        content,
        timestamp,
        model,
        verification,
        contentId
      })
    ),
    source,
    label: {
      show: active && cfg.labels.exportLabel && anyAi,
      text: labelText,
      euIcon: active && euIcon,
      humanReviewed,
      editorialContact: humanReviewed ? cfg.editorialResponsibility.contact || null : null,
      provider
    },
    template: ['default', 'professional', 'minimal'].includes(request.options?.template)
      ? request.options.template
      : 'default',
    single: request.single === true
  };

  const rendered = await renderExport(format, doc);
  const manifestId = newManifestId();
  const filename = `${slug(title)}-${exportedAt.slice(0, 10)}.${rendered.extension}`;
  if (!active || !cfg.exports.sign || !cfg.signing.enabled) {
    return {
      buffer: rendered.buffer,
      mimeType: rendered.mimeType,
      filename,
      manifestId: null,
      signed: false
    };
  }

  const installationUrl = getInstallationUrl();
  const payload = {
    v: 1,
    typ: 'ihub-export-manifest',
    manifestId,
    format,
    title,
    createdAt: exportedAt,
    generator: { name: 'iHub Apps', version: getAppVersion() },
    installationId: getInstallationId(),
    ...(installationUrl ? { signpost: `${installationUrl}/.well-known/ai-provenance` } : {}),
    aiGenerated: anyAi,
    digitalSourceType:
      humanContent || anyEdited
        ? DIGITAL_SOURCE_TYPES.compositeWithTrainedAlgorithmicMedia
        : DIGITAL_SOURCE_TYPES.trainedAlgorithmicMedia,
    action: anyEdited ? 'c2pa.edited' : 'c2pa.created',
    source,
    verification: anyEdited ? 'asserted' : 'verified',
    humanReviewed,
    ...(humanReviewed && cfg.editorialResponsibility.contact
      ? { editorialResponsibility: cfg.editorialResponsibility.contact }
      : {}),
    label: { visible: doc.label.show, euIcon: doc.label.euIcon },
    messages: verified.map(m => ({
      index: m.index,
      role: m.role,
      contentHash: hashContent(m.content),
      verification: m.verification,
      ...(m.contentId ? { contentId: m.contentId } : {}),
      ...(m.model ? { model: m.model } : {})
    }))
  };

  const signed = await signExport({
    format,
    buffer: rendered.buffer,
    payload,
    meta: { generator, provider, labelText },
    signpost: signpostEnabled('exports', cfg, app)
  });

  await provenanceStore.recordExport({
    manifestId,
    fileHash: signed.fileHash,
    format,
    jws: signed.jws,
    messages: payload.messages,
    verification: payload.verification
  });

  return {
    buffer: signed.buffer,
    mimeType: rendered.mimeType,
    filename,
    manifestId,
    signed: Boolean(signed.jws)
  };
}
