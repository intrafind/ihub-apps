/**
 * Source producers: how what a tool returned becomes the sources the chat
 * shows. The loop asks {@link extractToolSources} after every tool call
 * (`services/loop/AgentLoop.js`); the first of these that applies wins:
 *
 *  1. a `sources` declaration in the tool definition (`producers/declared.js`) —
 *     an admin maps any tool's result without code;
 *  2. a registered producer — {@link registerSourceProducer} for integrations
 *     with result shapes of their own, then the built-in ones for web search
 *     and the page reader (`producers/web.js`) and the iFinder tools
 *     (`producers/ifinder.js`);
 *  3. the tool's own report in its result (`producers/envelope.js`): a
 *     `sources` array, MCP `resource_link` blocks or `structuredContent.sources`.
 *
 * Model adapters report theirs on the chunk (`chunk.sources`, e.g. iAssistant),
 * and provider-run web search on the chunk's `groundingMetadata`
 * (`shared/sources/grounding.js`); the loop passes both through
 * {@link finalizeSourceFrame} too.
 *
 * A producer:
 *
 * ```js
 * registerSourceProducer({
 *   id: 'confluence',
 *   matches: ({ toolId, toolDef }) => toolId.startsWith('confluence_'),
 *   fromToolResult: ({ toolId, toolDef, args, result, failed }) => ({ items, queries })
 * });
 * ```
 *
 * @module services/sources
 */
import { emptySourceSet, mergeSources } from '../../../shared/sources/index.js';
import { declarationOf, declaredSources } from './producers/declared.js';
import { envelopeSources } from './producers/envelope.js';
import { iFinderSourceProducer } from './producers/ifinder.js';
import { webSourceProducer } from './producers/web.js';
import { hasSourceProvider } from './providers.js';
import logger from '../../utils/logger.js';

/** Most sources one frame reports; a search returns at most 100 hits, usually 10. */
export const MAX_FRAME_SOURCES = 50;
const MAX_FRAME_QUERIES = 10;
/**
 * Size of one frame on the ledger and the wire; past it, passages beyond each
 * source's first go, then sources from the end.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

function frameSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** A frame within {@link MAX_FRAME_BYTES}. */
function boundFrame(frame) {
  if (frameSize(frame) <= MAX_FRAME_BYTES) return frame;
  const items = frame.items.map(source =>
    source.passages?.length > 1 ? { ...source, passages: source.passages.slice(0, 1) } : source
  );
  const bounded = { ...frame, items };
  while (items.length && frameSize(bounded) > MAX_FRAME_BYTES) items.pop();
  return bounded;
}

const BUILT_IN_PRODUCERS = [webSourceProducer, iFinderSourceProducer];
const registered = [];

/**
 * @param {{id: string, matches: Function, fromToolResult: Function}} producer
 */
export function registerSourceProducer(producer) {
  if (
    !producer ||
    typeof producer.id !== 'string' ||
    typeof producer.matches !== 'function' ||
    typeof producer.fromToolResult !== 'function'
  ) {
    throw new TypeError('A source producer needs an id, matches() and fromToolResult()');
  }
  registered.push(producer);
}

/** Test hook: forget registered producers. */
export function _resetSourceProducers() {
  registered.length = 0;
}

function parseResult(result) {
  if (typeof result !== 'string') return result;
  const text = result.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return result;
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

/** The provider a tool's own sources belong to when they name none. */
function defaultProviderOf(toolId, toolDef) {
  const serverId = toolDef?._mcp?.serverId;
  return serverId ? `mcp:${serverId}` : String(toolId || 'unknown');
}

/**
 * A frame as it goes on the ledger and the wire: every source normalized
 * (with the producer's defaults), bounded, and keeping a `ref` only when its
 * provider can act on it — a ref no provider serves would offer actions that
 * cannot work. A source with a ref is private.
 *
 * @param {{items?: Array, queries?: string[], supports?: Array}|null} frame
 * @param {Object} [defaults] - `provider`, `kind`, `private` where a source names none
 * @returns {{items: Array, queries: string[], supports?: Array}|null} null when it reports nothing
 */
export function finalizeSourceFrame(frame, defaults = {}) {
  if (!frame || typeof frame !== 'object') return null;
  // Folded like any set, so two sightings in one frame (a search hit and the
  // page the search went on to read) become one source.
  const merged = mergeSources(emptySourceSet(), frame, defaults);
  const items = merged.items.slice(0, MAX_FRAME_SOURCES).map(source => {
    if (!source.ref) return source;
    if (!hasSourceProvider(source.provider)) {
      const { ref: _ref, ...rest } = source;
      return rest;
    }
    // Fetched with the user's own permissions: never in a share, whatever
    // the producer said.
    return { ...source, private: true };
  });
  const queries = merged.queries.slice(0, MAX_FRAME_QUERIES);
  const { supports } = merged;
  if (!items.length && !queries.length && !supports.length) return null;
  return boundFrame({ items, queries, ...(supports.length ? { supports } : {}) });
}

/**
 * The sources one tool call reported.
 *
 * @param {Object} call
 * @param {string} call.toolId
 * @param {Object} [call.toolDef] - the resolved tool definition
 * @param {Object} [call.args]
 * @param {unknown} call.result - the tool's full result (object, array or JSON text)
 * @param {boolean} [call.failed] - the call threw or returned an error
 * @returns {{items: Array, queries: string[]}|null}
 */
export function extractToolSources({ toolId, toolDef, args, result, failed = false }) {
  const parsed = parseResult(result);
  const defaults = { provider: defaultProviderOf(toolId, toolDef), private: true };
  try {
    const declaration = declarationOf(toolDef);
    if (declaration) {
      if (failed) return null;
      const declared = declaredSources(declaration, { args, result: parsed });
      return finalizeSourceFrame(declared, { ...defaults, ...declared.defaults });
    }
    const call = { toolId: String(toolId || ''), toolDef, args, result: parsed, failed };
    const producer = [...registered, ...BUILT_IN_PRODUCERS].find(candidate =>
      candidate.matches(call)
    );
    if (producer) return finalizeSourceFrame(producer.fromToolResult(call), defaults);
    return failed ? null : finalizeSourceFrame(envelopeSources(parsed), defaults);
  } catch (error) {
    // Reporting sources must never fail a tool call.
    logger.warn('Source extraction failed', { component: 'sources', toolId, error: error.message });
    return null;
  }
}
