// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * LocalKnowledgeProvider — BM25 over the stored text of a local project
 * (spec 2 §2). The retrieval is `server/sources/documentRetrieval.js`, the
 * code that already searches the support bot's documentation: heading
 * sections, 6 000-character parts, BM25 with title and path weights, over
 * every ready item of a project as one corpus.
 *
 * The corpus index lives in a per-process LRU keyed by the project and a
 * fingerprint of its items (their text hashes, or for link items the
 * fetched text), so a change to any item rebuilds it and nothing is ever
 * indexed from anything but stored or freshly fetched text. At 50 items the
 * rebuild is milliseconds; there is no persistent index.
 *
 * @module services/knowledge/LocalKnowledgeProvider
 */
import { createHash } from 'node:crypto';
import {
  RESULT_BUDGET_CHARS,
  buildCorpusIndex,
  collectHits,
  getContentStats,
  selectContent
} from '../../sources/documentRetrieval.js';
import { getProjectService } from '../projects/ProjectService.js';
import { KnowledgeProvider } from './KnowledgeProvider.js';
import { getItemText } from './ItemTextService.js';
import { KnowledgeError, docOf, isUsable } from './types.js';

/** Corpus indexes kept per process. */
const INDEX_CACHE_SIZE = 32;
const indexCache = new Map();

function cacheGet(key) {
  const entry = indexCache.get(key);
  if (!entry) return null;
  indexCache.delete(key);
  indexCache.set(key, entry);
  return entry;
}

function cacheSet(key, value) {
  indexCache.set(key, value);
  while (indexCache.size > INDEX_CACHE_SIZE) indexCache.delete(indexCache.keys().next().value);
}

/** Test and cascade hook: forget every cached index of a project (or all). */
export function evictProjectIndex(projectId) {
  for (const key of [...indexCache.keys()]) {
    if (!projectId || key.startsWith(`${projectId}:`)) indexCache.delete(key);
  }
}

/** Bytes a text takes inside a JSON document: UTF-8, quotes and escapes included. */
function serializedBytes(text) {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export class LocalKnowledgeProvider extends KnowledgeProvider {
  get id() {
    return 'local';
  }

  capabilities(_project) {
    return {
      loadAll: true,
      iterate: true,
      search: true,
      passages: true,
      preview: 'text',
      write: true
    };
  }

  /**
   * The usable items of a project, with their text, and the ones that are
   * not usable with the reason. Link items are fetched here (with the
   * reader's rights), so one call serves search, read and load-all alike.
   *
   * @param {Object} project
   * @param {import('./KnowledgeProvider.js').KnowledgeContext} ctx
   * @param {{itemIds?: string[]}} [options]
   * @returns {Promise<{texts: Array<{item: Object, text: string, truncated: boolean,
   *   failed: string[]}>, unavailable: Array}>} `truncated`: the source handed over only
   *   the start of the document; `failed`: documents of an iFinder search it could not fetch
   */
  async texts(project, ctx, { itemIds } = {}) {
    const wanted = itemIds ? new Set(itemIds) : null;
    const texts = [];
    const unavailable = [];
    for (const item of project.items || []) {
      if (wanted && !wanted.has(item.id)) continue;
      if (!isUsable(item)) {
        unavailable.push({
          document: item.id,
          name: item.name,
          reason: item.status,
          ...(item.error?.code ? { code: item.error.code } : {})
        });
        continue;
      }
      try {
        const { text, truncated, failed = [] } = await getItemText(project, item, ctx);
        texts.push({ item, text, truncated: truncated === true, failed });
      } catch (error) {
        unavailable.push({
          document: item.id,
          name: item.name,
          reason: error instanceof KnowledgeError ? error.code : 'ERROR',
          message: error.message
        });
      }
    }
    return { texts, unavailable };
  }

  _index(project, ctx, texts) {
    const fingerprint = hash(
      texts
        .map(
          ({ item, text }) =>
            `${item.id}:${item.text?.sha256 || hash(text)}:${item.storage === 'link' && item.kind.startsWith('ifinder') ? ctx.user?.id || '' : ''}`
        )
        .join('|')
    );
    const key = `${project.id}:${fingerprint}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const index = buildCorpusIndex(
      texts.map(({ item, text }) => ({ id: item.id, name: item.name, text }))
    );
    cacheSet(key, index);
    return index;
  }

  async list(project, _ctx, { cursor = null, limit = 100 } = {}) {
    const items = [...(project.items || [])]
      .sort((a, b) => {
        const ua = isUsable(a) ? 0 : 1;
        const ub = isUsable(b) ? 0 : 1;
        return ua - ub || String(a.name).localeCompare(String(b.name));
      })
      .map(item => docOf(project, item));
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const page = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length ? String(start + limit) : null;
    return { items: page, nextCursor };
  }

  async search(
    project,
    ctx,
    { query, limit = 8, itemIds, budgetChars = RESULT_BUDGET_CHARS } = {}
  ) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) throw new KnowledgeError('INVALID_REF', 'A query is needed', { projectId: project.id });
    const { texts, unavailable } = await this.texts(project, { ...ctx, query: q }, { itemIds });
    const index = this._index(project, ctx, texts);
    const byId = new Map(texts.map(({ item }) => [item.id, item]));
    const hits = collectHits(index, q, { limit, budgetChars }).map(hit => ({
      docId: hit.docId,
      projectId: project.id,
      sectionId: hit.sectionId,
      title: hit.title,
      path: hit.path,
      part: `${hit.part}/${hit.partCount}`,
      text: hit.text,
      score: Math.round(hit.score * 100) / 100,
      chars: hit.chars,
      name: byId.get(hit.docId)?.name || ''
    }));
    const partial = texts.filter(entry => entry.truncated).map(entry => entry.item.id);
    const missing = texts.filter(entry => entry.failed.length).map(entry => entry.item.id);
    return {
      hits,
      unavailable,
      retrieval: {
        mode: 'search',
        query: q,
        documents: texts.length,
        // Searched as far as their source handed them over, not to the end.
        ...(partial.length ? { truncatedDocuments: partial } : {}),
        // Searched without the documents their source could not fetch.
        ...(missing.length ? { incompleteDocuments: missing } : {}),
        totalSections: index.sections.length,
        totalTokens: index.tokens,
        returnedTokens: Math.round(hits.reduce((sum, hit) => sum + hit.chars, 0) / 4)
      }
    };
  }

  /**
   * One document, or a section of it, within a budget: `budgetBytes` bounds
   * the text as it serializes into a JSON result (UTF-8, escapes included),
   * `budgetChars` in characters. A document over the budget comes back as
   * its outline, and a section read names the id it continues at.
   */
  async read(
    project,
    ctx,
    { itemId },
    { section, budgetChars = RESULT_BUDGET_CHARS, budgetBytes } = {}
  ) {
    const item = (project.items || []).find(entry => entry.id === itemId);
    if (!item)
      throw new KnowledgeError('ITEM_NOT_FOUND', 'Document not found', {
        projectId: project.id,
        itemId
      });
    const { text, truncated, failed = [] } = await getItemText(project, item, ctx);
    const selected = selectContent(text, {
      section,
      name: item.name,
      ...(Number.isFinite(budgetBytes)
        ? { budgetChars: budgetBytes, measure: serializedBytes }
        : { budgetChars })
    });
    return {
      doc: docOf(project, item),
      text: selected.content,
      // The source handed over only the start of the document, or lacks
      // documents it could not fetch: even a `full` read is not the whole of
      // it, and no section reaches the rest.
      retrieval: {
        ...selected.retrieval,
        ...(truncated ? { sourceTruncated: true } : {}),
        ...(failed.length ? { sourceFailed: failed.length } : {})
      }
    };
  }

  async loadAll(project, ctx, { itemIds } = {}) {
    const { texts, unavailable } = await this.texts(project, ctx, { itemIds });
    let tokens = 0;
    const docs = texts.map(({ item, text, truncated, failed }) => {
      const stats = getContentStats(text);
      tokens += stats.tokens;
      return {
        doc: docOf(project, item),
        text,
        tokens: stats.tokens,
        ...(truncated ? { truncated: true, sourceTruncated: true } : {}),
        ...(failed.length ? { sourceFailed: failed.length } : {})
      };
    });
    return { docs, unavailable, tokens };
  }

  /**
   * Store a text as a document of the project.
   *
   * @param {Object} project
   * @param {import('./KnowledgeProvider.js').KnowledgeContext} ctx
   * @param {{name: string, text: string, contentType?: string, pinned?: boolean,
   *   wait?: boolean, authorize?: (project: Object) => boolean}} input - `wait: false`
   *   returns the `pending` document at once; omitted, the text is stored inline as
   *   before. `authorize` is checked again on the current project under the
   *   repository's lock, so a writer who lost the right since the caller's
   *   check cannot add the document (`PROJECT_ACCESS_CHANGED`).
   * @returns {Promise<import('./KnowledgeProvider.js').KnowledgeDoc>}
   */
  async put(
    project,
    ctx,
    { name, text, contentType = 'text/markdown', pinned = false, wait, authorize }
  ) {
    const service = getProjectService();
    const { item } = await service.addItem(
      project.id,
      { kind: 'upload', ref: { contentType }, name, text, pinned },
      { user: ctx.user, authorize, origin: 'written', run: ctx.run || null, wait }
    );
    evictProjectIndex(project.id);
    return docOf(project, item);
  }

  async remove(project, ctx, { itemId }) {
    const service = getProjectService();
    await service.removeItem(project.id, itemId, { user: ctx.user });
    evictProjectIndex(project.id);
    return true;
  }
}

export default LocalKnowledgeProvider;
