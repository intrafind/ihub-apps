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
 *    handlers (`PageHandler`, `IFinderHandler`) and their TTL caches. A web
 *    page is not a link any more: it is a stored snapshot (#3622), so no
 *    reader fetches it or parses its HTML. iFinder items are fetched with the **reading** user's rights;
 *    the handler's cache is keyed per user already.
 *  - A `project-item` link reads the item of another project it stands for,
 *    after checking that the **reading** user may use that project
 *    (`projectItemLinks.js`).
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
import { PROJECT_ITEM_KIND, loadLinkedItem } from '../projects/projectItemLinks.js';
import { projectSettings } from '../projects/projectSettings.js';
import { itemTextCacheBytes } from '../../utils/cacheBudgets.js';

const COMPONENT = 'ItemTextService';

/**
 * Decrypted texts kept per process, and the bytes they may add up to — a share
 * of this process's heap limit (utils/cacheBudgets.js).
 */
const TEXT_CACHE_ENTRIES = 64;

/**
 * The byte budget of the text cache: `projects.textCache.maxHeapShare` of the
 * heap (#3650), read when the cache is used; absent, the built-in budget.
 *
 * @param {Object} [platformConfig] - Platform configuration; the loaded one by default
 * @returns {number} Bytes
 */
export function textCacheBudgetBytes(platformConfig = configCache.getPlatform?.()) {
  return itemTextCacheBytes(undefined, projectSettings(platformConfig).textCache.maxHeapShare);
}

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
  const budget = textCacheBudgetBytes();
  // A 10 MB text (20 MB as UTF-16) must fit: it is read on every search.
  if (bytes > budget / 2) return;
  if (textCache.has(key)) textCacheBytes -= textCache.get(key).bytes;
  textCache.set(key, { text, bytes });
  textCacheBytes += bytes;
  while (textCache.size > TEXT_CACHE_ENTRIES || textCacheBytes > budget) {
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

let infoRecorder = null;

/** Items (by reference) whose first read already offered what they are about, in this process. */
const infoOffered = new Set();

/**
 * Register the recorder of what a link item is about, learned on its first
 * read: `(project, item, {title, description}) → Promise`. The project
 * service registers it at startup (#3539); it runs in the background and its
 * failure never fails the read.
 *
 * @param {((project: Object, item: Object, info: Object) => Promise<unknown>)|null} recorder
 */
export function setItemInfoRecorder(recorder) {
  infoRecorder = typeof recorder === 'function' ? recorder : null;
  infoOffered.clear();
}

/**
 * What a link item's source says about it: an iFinder document its title
 * field, else its file name. (A web page's title and description come from
 * its extraction, when its snapshot is stored.)
 */
export function linkInfoOf(item, metadata) {
  if (item.kind === 'ifinder-document') {
    return { title: firstText(metadata?.title) || firstText(metadata?.filename) };
  }
  return {};
}

/** One value of an iFinder field, which may hold a list. */
function firstText(value) {
  const first = Array.isArray(value) ? value.find(Boolean) : value;
  return typeof first === 'string' ? first : '';
}

/**
 * Hand what a link item's source said about it to the recorder, once per item
 * and process, when the item has no title or description yet.
 */
export function offerItemInfo(project, item, metadata) {
  if (!infoRecorder || item.title || item.description) return;
  const { title, description } = linkInfoOf(item, metadata);
  if (!title && !description) return;
  // The reference is part of the key: an item pointed elsewhere has lost its
  // title (applyItemRef) and records the new one on its next read.
  const key = `${project.id}/${item.id}/${JSON.stringify(item.ref || {})}`;
  if (infoOffered.has(key)) return;
  // Bounded: forgetting only means a later read offers again, which records nothing twice.
  if (infoOffered.size >= 10000) infoOffered.clear();
  infoOffered.add(key);
  Promise.resolve()
    .then(() => infoRecorder(project, item, { title, description }))
    .catch(error => {
      // Not recorded: a later read may try again.
      infoOffered.delete(key);
      logger.debug('Could not record what a link item is about', {
        component: COMPONENT,
        projectId: project.id,
        itemId: item.id,
        error: error?.message
      });
    });
}

/** The handler type and config a link item's fetch runs with. */
function handlerCallOf(item, ctx) {
  const ref = item.ref || {};
  switch (item.kind) {
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
  if (item.kind === PROJECT_ITEM_KIND) {
    const linked = await loadLinkedItem(project, item, ctx.user);
    return getItemText(linked.project, linked.item, ctx);
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
    offerItemInfo(project, item, result?.metadata);
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
