// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ItemTextService — the one place that turns a project item into text
 * (spec 2 §2.1).
 *
 *  - A `storage: 'text'` item holds an encrypted blob. Reading it is the
 *    job of the ingest pipeline's decryptor (spec 3), which registers itself
 *    here through {@link setTextReader}; until then such an item answers
 *    `TEXT_UNAVAILABLE`.
 *  - A `storage: 'link'` item is fetched at use time through today's source
 *    handlers (`URLHandler`, `PageHandler`, `IFinderHandler`) and their TTL
 *    caches. iFinder items are fetched with the **reading** user's rights;
 *    the handler's cache is keyed per user already.
 *
 * A per-process LRU of decrypted text keeps a project that is read on every
 * turn from being decrypted on every turn.
 *
 * @module services/knowledge/ItemTextService
 */
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { createSourceManager } from '../../sources/index.js';
import { KnowledgeError } from './types.js';

const COMPONENT = 'ItemTextService';

/** Decrypted texts kept per process, and the bytes they may add up to. */
const TEXT_CACHE_ENTRIES = 64;
const TEXT_CACHE_BYTES = 64 * 1024 * 1024;

const textCache = new Map();
let textCacheBytes = 0;

function cacheGet(key) {
  const entry = textCache.get(key);
  if (!entry) return null;
  // Refresh recency.
  textCache.delete(key);
  textCache.set(key, entry);
  return entry.text;
}

function cacheSet(key, text) {
  const bytes = text.length * 2;
  if (bytes > TEXT_CACHE_BYTES / 4) return;
  if (textCache.has(key)) textCacheBytes -= textCache.get(key).bytes;
  textCache.set(key, { text, bytes });
  textCacheBytes += bytes;
  while (textCache.size > TEXT_CACHE_ENTRIES || textCacheBytes > TEXT_CACHE_BYTES) {
    const [oldest] = textCache.keys();
    textCacheBytes -= textCache.get(oldest).bytes;
    textCache.delete(oldest);
  }
}

/** Forget one blob's text (the item was refreshed or removed), or all. */
export function evictItemText(blobKey) {
  if (!blobKey) {
    textCache.clear();
    textCacheBytes = 0;
    return;
  }
  const entry = textCache.get(blobKey);
  if (entry) {
    textCacheBytes -= entry.bytes;
    textCache.delete(blobKey);
  }
}

let textReader = null;

/**
 * Register the reader of stored text blobs: `(project, item) → Promise<string>`.
 * The ingest pipeline (spec 3) owns decryption and registers it at startup.
 *
 * @param {((project: Object, item: Object) => Promise<string>)|null} reader
 */
export function setTextReader(reader) {
  textReader = typeof reader === 'function' ? reader : null;
}

/** The handler type and config a link item's fetch runs with. */
function handlerCallOf(item, ctx) {
  const ref = item.ref || {};
  switch (item.kind) {
    case 'url':
      return {
        type: 'url',
        config: {
          url: ref.url,
          ...(ref.maxContentLength ? { options: { maxContentLength: ref.maxContentLength } } : {}),
          chatId: ctx.chatId
        }
      };
    case 'page':
      return {
        type: 'page',
        config: { pageId: ref.pageId, language: ref.language || ctx.language || 'en' }
      };
    case 'ifinder-document':
      return {
        type: 'ifinder',
        config: {
          documentId: ref.documentId,
          searchProfile: ref.searchProfile,
          maxLength: ref.maxLength,
          user: ctx.user,
          chatId: ctx.chatId || `project-${item.id}`
        }
      };
    case 'ifinder-query': {
      const query = ref.query || ctx.query || '';
      return {
        type: 'ifinder',
        config: {
          query,
          searchProfile: ref.searchProfile,
          maxResults: ref.maxResults,
          maxLength: ref.maxLength,
          user: ctx.user,
          chatId: ctx.chatId || `project-${item.id}`
        }
      };
    }
    default:
      return null;
  }
}

/**
 * How much of its document a handler result is, for two different reasons
 * the model is told apart:
 *
 *  - `truncated`: the handler cut the text at its length limit
 *    (`metadata.truncated`; iFinder at `maxLength`, 10 000 characters by
 *    default), or, for an iFinder search, cut one of the documents it loaded;
 *  - `failed`: an iFinder search found documents whose content could not be
 *    fetched (`metadata.failedDocuments`), so they are missing from the text.
 *
 * @param {Object|undefined} metadata
 * @returns {{truncated: boolean, failed: string[]}}
 */
function completenessOf(metadata) {
  const truncated =
    metadata?.truncated === true ||
    (Array.isArray(metadata?.documents) &&
      metadata.documents.some(entry => entry?.truncated === true));
  const failed = Array.isArray(metadata?.failedDocuments)
    ? metadata.failedDocuments.map(entry => String(entry?.documentId ?? '')).filter(Boolean)
    : [];
  return { truncated, failed };
}

/**
 * The page routes' policy (`authRequired`, `allowedGroups` on the page in
 * `ui.pages`), applied to the reader of a page item: a project is not a way
 * round a page's own access control, whoever added the item.
 *
 * @param {string} pageId
 * @param {Object|null|undefined} user
 * @param {Object} where
 */
function assertPageReadable(pageId, user, where) {
  const page = configCache.getUI?.()?.data?.pages?.[pageId];
  if (!page) throw new KnowledgeError('SOURCE_GONE', `Page ${pageId} does not exist`, where);
  const anonymous = !user || user.id === 'anonymous' || user.anonymous === true;
  if (page.authRequired && anonymous) {
    throw new KnowledgeError('SOURCE_FORBIDDEN', `Page ${pageId} needs a signed-in reader`, where);
  }
  const allowed = Array.isArray(page.allowedGroups) ? page.allowedGroups : [];
  if (allowed.length > 0 && !allowed.includes('*')) {
    const groups = Array.isArray(user?.groups) ? user.groups : [];
    if (!groups.some(group => allowed.includes(group))) {
      throw new KnowledgeError(
        'SOURCE_FORBIDDEN',
        `Page ${pageId} is not open to this reader`,
        where
      );
    }
  }
}

/**
 * The text of one item.
 *
 * @param {Object} project
 * @param {Object} item
 * @param {import('./KnowledgeProvider.js').KnowledgeContext} ctx
 * @returns {Promise<{text: string, cached: boolean, truncated: boolean, failed: string[]}>}
 *   `truncated` says the text holds only part of the document: a stored text cut by the
 *   extraction limits (`item.text.truncated`), or a link item past its handler's
 *   length limit. The text is a prefix, and nothing here reaches the rest.
 *   `failed` lists the documents an iFinder search found but could not fetch: they are
 *   missing from the text.
 * @throws {KnowledgeError} `ITEM_NOT_READY`, `TEXT_UNAVAILABLE`, `SOURCE_FORBIDDEN`,
 *   `SOURCE_GONE`, `KIND_UNKNOWN`.
 */
export async function getItemText(project, item, ctx = {}) {
  const where = { projectId: project?.id, itemId: item?.id };
  if (!item || (item.status !== 'ready' && item.status !== 'stale')) {
    throw new KnowledgeError('ITEM_NOT_READY', `Item ${item?.id || ''} is not ready`, where);
  }
  if (item.storage === 'text') {
    const key = item.text?.blobKey;
    if (!key) throw new KnowledgeError('TEXT_UNAVAILABLE', 'The item holds no text yet', where);
    // Recorded at ingest: the extraction cut the document (pages, rows, characters).
    const truncated = item.text.truncated === true;
    const cached = cacheGet(key);
    if (cached !== null) return { text: cached, cached: true, truncated, failed: [] };
    if (!textReader) {
      throw new KnowledgeError(
        'TEXT_UNAVAILABLE',
        'Stored text cannot be read on this installation',
        where
      );
    }
    const text = await textReader(project, item);
    cacheSet(key, text);
    return { text, cached: false, truncated, failed: [] };
  }
  const call = handlerCallOf(item, ctx);
  if (!call) throw new KnowledgeError('KIND_UNKNOWN', `Unknown item kind ${item.kind}`, where);
  if (call.type === 'page') assertPageReadable(call.config.pageId, ctx.user, where);
  if (call.type === 'ifinder' && !ctx.user) {
    throw new KnowledgeError('SOURCE_FORBIDDEN', 'iFinder items need a signed-in reader', where);
  }
  if (call.type === 'ifinder' && !call.config.documentId && !call.config.query) {
    throw new KnowledgeError('INVALID_REF', 'This iFinder search needs a query', where);
  }
  try {
    const handler = createSourceManager().getHandler(call.type);
    const result = await handler.getCachedContent(call.config);
    const text =
      typeof result?.content === 'string' ? result.content : String(result?.content || '');
    return { text, cached: false, ...completenessOf(result?.metadata) };
  } catch (error) {
    const message = String(error?.message || 'fetch failed');
    logger.warn('Could not fetch a link item', { component: COMPONENT, ...where, error: message });
    if (/not found|404|gone/i.test(message))
      throw new KnowledgeError('SOURCE_GONE', message, where);
    if (/denied|forbidden|401|403/i.test(message))
      throw new KnowledgeError('SOURCE_FORBIDDEN', message, where);
    throw new KnowledgeError('SOURCE_GONE', message, where);
  }
}
