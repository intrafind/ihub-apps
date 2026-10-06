/**
 * The per-turn cap on page reads (`websearch.maxPageReads`).
 *
 * The page reader (`read_url`) is offered next to every web search
 * tool, and nothing but the chat's round cap bounded how often one answer
 * could call it — each call lands up to 50 000 characters in the context. The
 * gate counts the reader's calls in one chat turn and, past the cap, answers
 * the call itself with a plain result telling the model to answer with what
 * it has. It is not an error: a refused read is expected behaviour, and an
 * error would count towards the loop's circuit breaker.
 *
 * Only calls the model makes to the reader count. The pages a search tool
 * fetches for its own excerpts (`extractContent`) do not; they stay bounded by
 * the search's `maxResults`.
 *
 * @module services/chat/pageReadLimit
 */

/** Page reads one answer may make when the app sets no `websearch.maxPageReads`. */
export const DEFAULT_MAX_PAGE_READS = 5;

/** Tool id of the page reader (see `toolLoader.READ_URL_TOOL_ID`). */
const PAGE_READER_TOOL_ID = 'read_url';

/** Code on the result of a read the cap refused. */
export const PAGE_READ_LIMIT_CODE = 'PAGE_READ_LIMIT_REACHED';

/**
 * @param {Object} [app] - App configuration
 * @returns {number} The app's cap, or {@link DEFAULT_MAX_PAGE_READS}
 */
export function resolveMaxPageReads(app) {
  const value = Number(app?.websearch?.maxPageReads);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_PAGE_READS;
}

/**
 * What the model gets back for a read past the cap.
 * @param {number} limit
 * @returns {{limitReached: true, code: string, maxPageReads: number, message: string}}
 */
export function pageReadLimitResult(limit) {
  return {
    limitReached: true,
    code: PAGE_READ_LIMIT_CODE,
    maxPageReads: limit,
    message:
      `Page read limit reached for this turn (${limit} of ${limit} pages read). ` +
      'Do not open more pages: answer with what you have, and tell the user they can ' +
      'ask you to continue in the next message if more reading is needed.'
  };
}

/**
 * A counter for one chat turn.
 *
 * @param {number} limit - Most page reads allowed in the turn
 * @returns {{admit: (toolId: string) => Object|null, readonly used: number}}
 *   `admit` returns null when the call may run, or the result to hand the
 *   model instead
 */
export function createPageReadGate(limit) {
  let used = 0;
  return {
    admit(toolId) {
      if (String(toolId || '').toLowerCase() !== PAGE_READER_TOOL_ID) return null;
      if (used >= limit) return pageReadLimitResult(limit);
      used += 1;
      return null;
    },
    get used() {
      return used;
    }
  };
}
