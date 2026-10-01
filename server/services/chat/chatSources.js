/**
 * The sources behind a chat answer, as the chat stores them with it, so that
 * reopening the chat draws the same sources panel and inline citations.
 *
 * The set is the one the loop folded from the turn's `sources/added` frames
 * (`LoopResult.sources`), which the client folded the same way live; what is
 * stored is its normalized form (`shared/sources/sourceSet.storedSourceSet`)
 * within a size bound, since a chat document is rewritten on every message and
 * read back whole when the chat opens.
 *
 * @module services/chat/chatSources
 */
import { storedSourceSet } from '../../../shared/sources/index.js';
import { jsonByteLength } from '../mcp/mcpApps.js';

/** Stored size of one answer's sources; past it, passages go first, then sources. */
export const MAX_STORED_SOURCES_BYTES = 256 * 1024;

/**
 * @param {Object|null} set - the turn's source set
 * @returns {{items: Array, queries: string[]}|null} null when nothing is left to store
 */
export function boundStoredSources(set) {
  const stored = storedSourceSet(set);
  if (!stored) return null;
  if (jsonByteLength(stored) <= MAX_STORED_SOURCES_BYTES) return stored;
  const items = stored.items.map(({ passages, ...source }) =>
    passages?.length ? { ...source, passages: passages.slice(0, 1) } : source
  );
  const bounded = { items, queries: stored.queries };
  while (items.length && jsonByteLength(bounded) > MAX_STORED_SOURCES_BYTES) items.pop();
  return items.length || bounded.queries.length ? bounded : null;
}
