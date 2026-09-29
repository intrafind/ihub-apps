/**
 * "Connect <server>" prompts on a chat message.
 *
 * A tool of an MCP server that uses per-user sign-in (`auth.type:
 * "oauthUser"`) answers a caller who has not connected the server with an
 * auth-required marker. The server puts it on `tool/completed` as
 * `authRequired: { serverId, serverName, connectUrl }` and stores it with the
 * answer as `mcpAuthRequired`; the run reducer keeps it on the tool entry and
 * this module projects it onto `message.mcpAuthRequired` — one entry per
 * server, however many of its tools asked.
 *
 * The sign-in leaves the page (full redirect to the authorization server) and
 * comes back to the chat with `?mcp_connected=<serverId>` or
 * `?mcp_error=<code>&mcp_server=<serverId>`. {@link consumeMcpConnectResult}
 * reads those parameters once and removes them from the URL (telling the
 * router, so it does not put them back), so a reload does not show the result
 * again. The result belongs to the page the sign-in returned to: after an
 * in-app navigation to another path it no longer applies. Whether a server is
 * connected *now* comes from `mcpConnectionStatus.js`. The URL that starts a sign-in is
 * built in `mcpConnectUrl.js` (kept apart: it depends on the runtime base
 * path, which this projection module must not load).
 *
 * @module features/chat/mcpApps/mcpConnectPrompts
 */
/** Query parameters the OAuth callback adds to the return URL. */
export const MCP_CONNECT_PARAMS = Object.freeze(['mcp_connected', 'mcp_error', 'mcp_server']);

/**
 * @param {unknown} prompt
 * @returns {boolean}
 */
function isPrompt(prompt) {
  return (
    !!prompt &&
    typeof prompt === 'object' &&
    typeof prompt.serverId === 'string' &&
    prompt.serverId.length > 0
  );
}

/**
 * Stored or projected prompts, well-formed and one per server.
 *
 * @param {unknown} prompts
 * @returns {Array<{serverId: string, serverName: string}>}
 */
export function normalizeMcpAuthPrompts(prompts) {
  if (!Array.isArray(prompts)) return [];
  const out = [];
  for (const prompt of prompts) {
    if (!isPrompt(prompt) || out.some(p => p.serverId === prompt.serverId)) continue;
    out.push({
      serverId: prompt.serverId,
      serverName:
        typeof prompt.serverName === 'string' && prompt.serverName
          ? prompt.serverName
          : prompt.serverId
    });
  }
  return out;
}

/**
 * The prompts of a run, from its tool entries.
 *
 * @param {Object} run - Run state from the run reducer
 * @returns {Array<{serverId: string, serverName: string}>|null} Null when there are none
 */
export function buildMcpAuthPrompts(run) {
  const prompts = normalizeMcpAuthPrompts((run?.tools || []).map(tool => tool?.authRequired));
  return prompts.length > 0 ? prompts : null;
}

const EMPTY_RESULT = Object.freeze({ connected: null, error: null, errorServer: null });

/** The sign-in result read for one page (path), read once. */
let consumed = null;

/**
 * The result of a sign-in that just returned to this page, read from the URL
 * on first call and then removed from it (history entry replaced, other
 * parameters kept, the router told through a `popstate` so its copy of the
 * search parameters drops them too). It applies to the path it was read on
 * only; on any other path the result is empty.
 *
 * @returns {{connected: string|null, error: string|null, errorServer: string|null}}
 */
export function consumeMcpConnectResult() {
  if (typeof window === 'undefined' || !window.location) return EMPTY_RESULT;
  const path = window.location.pathname;
  if (consumed && consumed.path === path) return consumed.result;
  let url;
  try {
    url = new URL(window.location.href);
  } catch {
    return EMPTY_RESULT;
  }
  consumed = {
    path,
    result: {
      connected: url.searchParams.get('mcp_connected'),
      error: url.searchParams.get('mcp_error'),
      errorServer: url.searchParams.get('mcp_server')
    }
  };
  if (MCP_CONNECT_PARAMS.some(name => url.searchParams.has(name))) {
    for (const name of MCP_CONNECT_PARAMS) url.searchParams.delete(name);
    try {
      window.history.replaceState(window.history.state, '', url.toString());
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    } catch {
      /* a sandboxed frame may refuse; the result is still read once */
    }
  }
  return consumed.result;
}

/** Test seam: forget the result read for this page load. */
export function resetMcpConnectResultForTests() {
  consumed = null;
}
