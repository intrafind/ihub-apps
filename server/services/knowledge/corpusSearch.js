// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The CPU half of a project search: the per-project corpus-index cache, BM25
 * over it, and the excerpt sections the scope planner injects. Pure — no
 * configuration, no I/O — so the same code runs on a search thread
 * (`searchWorker.js`, through `searchPool.js`) and, with the pool off, on the
 * event loop.
 *
 * @module services/knowledge/corpusSearch
 */
import { buildCorpusIndex, collectHits } from '../../sources/documentRetrieval.js';
import { estimateTokens } from '../../../shared/tokenEstimator.js';

/**
 * An LRU of corpus indexes keyed `${projectId}:${fingerprint}`, held to a
 * count and to the characters its indexes stand for.
 *
 * @returns {{get: Function, set: Function, evictProject: Function, size: Function}}
 */
export function createIndexCache() {
  const entries = new Map();
  const chars = () => {
    let weight = 0;
    for (const entry of entries.values()) weight += entry?.characters || 0;
    return weight;
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    /**
     * @param {string} key
     * @param {Object} index
     * @param {{maxEntries: number, maxChars: number}} limits
     * @returns {number} Entries dropped to fit the limits
     */
    set(key, index, { maxEntries, maxChars }) {
      entries.set(key, index);
      let evicted = 0;
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
        evicted += 1;
      }
      // A 10 MB text takes about 55 MB of heap as an index: hold the cache to a
      // weight too, dropping the oldest, never the entry just added.
      let weight = chars();
      for (const oldest of [...entries.keys()]) {
        if (weight <= maxChars || entries.size <= 1) break;
        weight -= entries.get(oldest)?.characters || 0;
        entries.delete(oldest);
        evicted += 1;
      }
      return evicted;
    },
    /** Forget every index of a project, or all of them without one. */
    evictProject(projectId) {
      for (const key of [...entries.keys()]) {
        if (!projectId || key.startsWith(`${projectId}:`)) entries.delete(key);
      }
    },
    size: () => ({ entries: entries.size, chars: chars() })
  };
}

function escapeXmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/**
 * One hit as the text of an excerpt: its section, with the id the model reads it by.
 *
 * @param {{sectionId: string, path: string[], part: string, text: string}} hit - `part` as `"2/3"`
 * @returns {string}
 */
export function renderExcerptSection(hit) {
  const attributes = [
    `id="${escapeXmlAttribute(hit.sectionId)}"`,
    `path="${escapeXmlAttribute(hit.path.join(' › '))}"`
  ];
  const [part, partCount] = String(hit.part).split('/');
  if (Number(partCount) > 1) attributes.push(`part="${part}/${partCount}"`);
  return `<section ${attributes.join(' ')}>\n${hit.text}\n</section>`;
}

/**
 * Rank a project's corpus for a query, building its index from `docs` when the
 * cache does not hold it.
 *
 * @param {ReturnType<typeof createIndexCache>} cache
 * @param {Object} request
 * @param {string} request.key - `${projectId}:${fingerprint}`
 * @param {Array<{id: string, name: string, text: string}>} [request.docs] - The
 *   texts; without them a cache miss answers `{ miss: true }`
 * @param {string} request.query
 * @param {number} [request.limit]
 * @param {number} [request.budgetChars]
 * @param {string[]} [request.docIds]
 * @param {{maxEntries: number, maxChars: number}} request.limits
 * @param {boolean} [request.sections=false] - Add each hit's excerpt `section`
 *   and its `sectionTokens` (the planner's excerpts; counting them is the slow part)
 * @returns {{miss: true, entries: number, chars: number}|{hits: Array,
 *   totalSections: number, totalTokens: number, buildSeconds: number|null,
 *   evicted: number, entries: number, chars: number}} `buildSeconds` is null
 *   when the index came from the cache
 */
export function searchIndex(cache, request) {
  const { key, docs, query, limit, budgetChars, docIds, limits, sections = false } = request;
  let index = cache.get(key);
  let buildSeconds = null;
  let evicted = 0;
  if (!index) {
    if (!docs) return { miss: true, ...cache.size() };
    const started = performance.now();
    index = buildCorpusIndex(docs);
    buildSeconds = (performance.now() - started) / 1000;
    evicted = cache.set(key, index, limits);
  }
  const hits = collectHits(index, query, { limit, budgetChars, docIds }).map(hit => {
    const found = {
      docId: hit.docId,
      sectionId: hit.sectionId,
      title: hit.title,
      path: hit.path,
      part: `${hit.part}/${hit.partCount}`,
      text: hit.text,
      score: Math.round(hit.score * 100) / 100,
      chars: hit.chars
    };
    if (sections) {
      found.section = renderExcerptSection(found);
      found.sectionTokens = estimateTokens(found.section);
    }
    return found;
  });
  return {
    hits,
    totalSections: index.sections.length,
    totalTokens: index.tokens,
    buildSeconds,
    evicted,
    ...cache.size()
  };
}
