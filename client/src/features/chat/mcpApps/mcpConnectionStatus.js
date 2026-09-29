/**
 * The caller's live connection state of per-user MCP servers, for the chat's
 * Connect cards.
 *
 * A Connect card is stored with the answer that needed it, so a reopened
 * chat shows it again long after the user connected. The card asks this
 * module whether the server is connected *now* (`GET
 * /api/mcp/oauth/connections`, the list Settings → Integrations shows). The
 * answer is shared by every card on the page for {@link STATUS_TTL_MS}, so a
 * chat with many cards makes one request.
 *
 * @module features/chat/mcpApps/mcpConnectionStatus
 */
import { apiClient } from '../../../api/client';

/** How long one answer is reused by the cards of a page. */
export const STATUS_TTL_MS = 30 * 1000;

/** @type {{at: number, promise: Promise<Map<string, boolean>>}|null} */
let cache = null;

/**
 * Map of server id → connected, for the per-user servers the caller may use.
 * Servers missing from the map are unknown to the caller. Resolves to an empty
 * map when the list cannot be loaded (the card then keeps its stored prompt).
 *
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Ignore a cached answer
 * @returns {Promise<Map<string, boolean>>}
 */
export function fetchMcpConnectionStates({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < STATUS_TTL_MS) return cache.promise;
  const promise = apiClient
    // A signed-out or anonymous caller gets a 401 here; that is an answer,
    // not an expired iHub session.
    .get('/mcp/oauth/connections', { _suppressAuthExpired: true })
    .then(({ data }) => {
      const states = new Map();
      for (const server of Array.isArray(data?.servers) ? data.servers : []) {
        if (server && typeof server.serverId === 'string') {
          states.set(server.serverId, server.connected === true);
        }
      }
      return states;
    })
    .catch(() => new Map());
  cache = { at: now, promise };
  return promise;
}

/** Forget the cached answer (after a sign-in or disconnect). */
export function invalidateMcpConnectionStates() {
  cache = null;
}
