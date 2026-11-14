// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Source producers: how what a tool returned becomes the sources the chat
 * shows. The loop asks {@link extractToolSources} after every tool call
 * (`services/loop/AgentLoop.js`); the first of these that applies wins:
 *
 *  1. a `sources` declaration in the tool definition (`producers/declared.js`) —
 *     an admin maps any tool's result without code;
 *  2. a registered producer — {@link registerSourceProducer} for integrations
 *     with result shapes of their own, then the built-in ones for web search
 *     and the page reader (`producers/web.js`), the iFinder tools and the
 *     iAssistant `ask` action (`producers/ifinder.js`);
 *  3. the tool's own report (`producers/envelope.js`): a `sources` array in
 *     its result, MCP `resource_link` blocks, or what the call reported beside
 *     its result (`toolCallScope.js`: an MCP result's `structuredContent.sources`).
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
 *   fromToolResult: ({ toolId, toolDef, args, result, reported, failed }) => ({ items, queries })
 * });
 * ```
 *
 * `reported` holds the source inputs the call reported beside its result
 * (`toolCallScope.js`); a producer that wants them includes them.
 *
 * @module services/sources
 */
import { emptySourceSet, mergeSources } from '../../../shared/sources/index.js';
import { declarationOf, declaredSources } from './producers/declared.js';
import { envelopeSources } from './producers/envelope.js';
import { iAssistantAskSourceProducer, iFinderSourceProducer } from './producers/ifinder.js';
import { projectSourceProducer } from './producers/project.js';
import { webSourceProducer } from './producers/web.js';
import { hasSourceProvider } from './providers.js';
import { activityOriginOf } from '../../utils/toolDisplay.js';
import { RECALL_TOOL_ID } from '../loop/seams/knowledgeSourceSeam.js';
import { integrationLabelOf } from '../../utils/toolIntegrationLabel.js';
import logger from '../../utils/logger.js';

/** Most sources one frame reports; a search returns at most 100 hits, usually 10. */
export const MAX_FRAME_SOURCES = 50;
const MAX_FRAME_QUERIES = 10;
/**
 * Size of one frame on the ledger and the wire; past it, passages beyond each
 * source's first go, then sources from the end.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Bytes of `value` as JSON. */
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

const BUILT_IN_PRODUCERS = [
  webSourceProducer,
  iFinderSourceProducer,
  iAssistantAskSourceProducer,
  projectSourceProducer
];
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

/** A tool result as data: JSON text parsed, anything else as it came. */
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

/**
 * The origin the sources of a call belong to when they name none: where the
 * server says the call looked (`activityOriginOf`, the classifier the footer's
 * basis and the activity line read), named by the integration for a connected
 * system. Decided by the call, never by a source's `provider`: an MCP tool
 * named like a web search is a connected system, whatever its sources say.
 */
function defaultOriginOf(toolId, toolDef) {
  const kind = activityOriginOf(toolDef || { id: toolId });
  if (!kind) return undefined;
  const label = kind === 'integration' ? integrationLabelOf(toolDef) : null;
  return label ? { kind, label } : { kind };
}

/**
 * A frame without the origin the tool put on its sources. Where a source was
 * found is decided by the server from the call, so what an MCP server, an
 * integration or a custom tool reports under `origin` is not believed: the
 * call's own origin is applied instead. The recall of earlier sources
 * (`chat_sources_read`) is the exception: its sources were placed by the
 * server when they were first found, and keep that.
 */
function withoutReportedOrigin(frame, toolId) {
  if (!frame || toolId === RECALL_TOOL_ID || !Array.isArray(frame.items)) return frame;
  return {
    ...frame,
    items: frame.items.map(item => {
      if (!item || typeof item !== 'object' || !('origin' in item)) return item;
      const { origin: _reported, ...rest } = item;
      return rest;
    })
  };
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
 * @returns {{items: Array, queries: string[], supports?: Array, scopes?: Array}|null} null
 *   when it reports nothing
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
  const { supports, scopes } = merged;
  // The integration scopes say where the rest was found; on their own they
  // are nothing to report.
  if (!items.length && !queries.length && !supports.length) return null;
  return boundFrame({
    items,
    queries,
    ...(supports.length ? { supports } : {}),
    ...(scopes ? { scopes } : {})
  });
}

/**
 * The sources one tool call reported.
 *
 * @param {Object} call
 * @param {string} call.toolId
 * @param {Object} [call.toolDef] - the resolved tool definition
 * @param {Object} [call.args]
 * @param {unknown} call.result - the tool's full result (object, array or JSON text)
 * @param {Array} [call.reported] - source inputs the call reported beside its
 *   result (`toolCallScope.js`); part of the tool's own report
 * @param {boolean} [call.failed] - the call threw or returned an error
 * @returns {{items: Array, queries: string[]}|null}
 */
export function extractToolSources({
  toolId,
  toolDef,
  args,
  result,
  reported = [],
  failed = false
}) {
  const parsed = parseResult(result);
  const origin = defaultOriginOf(toolId, toolDef);
  const defaults = {
    provider: defaultProviderOf(toolId, toolDef),
    private: true,
    ...(origin ? { origin } : {})
  };
  try {
    const declaration = declarationOf(toolDef);
    if (declaration) {
      if (failed) return null;
      const declared = declaredSources(declaration, { args, result: parsed });
      return finalizeSourceFrame(withoutReportedOrigin(declared, toolId), {
        ...defaults,
        ...declared.defaults
      });
    }
    const call = { toolId: String(toolId || ''), toolDef, args, result: parsed, reported, failed };
    const producer = [...registered, ...BUILT_IN_PRODUCERS].find(candidate =>
      candidate.matches(call)
    );
    if (producer) {
      return finalizeSourceFrame(
        withoutReportedOrigin(producer.fromToolResult(call), toolId),
        defaults
      );
    }
    if (failed) return null;
    const items = [...(envelopeSources(parsed)?.items || []), ...reported];
    return items.length
      ? finalizeSourceFrame(withoutReportedOrigin({ items }, toolId), defaults)
      : null;
  } catch (error) {
    // Reporting sources must never fail a tool call.
    logger.warn('Source extraction failed', { component: 'sources', toolId, error: error.message });
    return null;
  }
}

/**
 * What one tool call came to, declared by the server from the tool's full
 * result: `resultCount` (how many hits a search returned, `0` included) and
 * `readOutcome` (`opened` when a page or document read delivered text,
 * `empty` when it completed without any, for example a `read_url` with an
 * `offset` at the end of the page). A field is left out when the result does
 * not say, so the chat never infers "no results" or "opened" from an empty
 * source list. Only the built-in producers know their result shapes; a
 * declared or envelope source reports neither.
 *
 * @param {Object} call - as {@link extractToolSources}
 * @returns {{resultCount?: number, readOutcome?: 'opened'|'empty'}}
 */
export function extractToolOutcome({ toolId, toolDef, args, result, failed = false }) {
  try {
    if (failed || declarationOf(toolDef)) return {};
    const call = {
      toolId: String(toolId || ''),
      toolDef,
      args,
      result: parseResult(result),
      failed
    };
    const producer = [...registered, ...BUILT_IN_PRODUCERS].find(candidate =>
      candidate.matches(call)
    );
    if (typeof producer?.outcomeOf !== 'function') return {};
    const { resultCount, readOutcome } = producer.outcomeOf(call);
    return {
      ...(Number.isInteger(resultCount) && resultCount >= 0 ? { resultCount } : {}),
      ...(readOutcome === 'opened' || readOutcome === 'empty' ? { readOutcome } : {})
    };
  } catch (error) {
    logger.warn('Tool outcome failed', { component: 'sources', toolId, error: error.message });
    return {};
  }
}
