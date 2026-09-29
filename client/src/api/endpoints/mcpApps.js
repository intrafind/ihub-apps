import { apiClient } from '../client';
import { buildApiUrl } from '../../utils/runtimeBasePath';

/**
 * MCP Apps host endpoints (see server/routes/mcpAppRoutes.js). Every call
 * names the chat app and the tool whose call rendered the view; the server
 * authorizes against both.
 */

/**
 * The view's HTML and its sandbox metadata (CSP domains, permissions).
 * @param {string} appId
 * @param {string} toolId - iHub id of the tool that rendered the view
 * @returns {Promise<{uri:string, html:string, csp:Object, permissions:Object, allow:string, prefersBorder:(boolean|null), tool:Object, serverId:string}>}
 */
export const fetchMcpAppResource = async (appId, toolId) => {
  const { data } = await apiClient.get('/mcp-apps/resource', { params: { appId, toolId } });
  return data;
};

/**
 * A `tools/call` made by the view, proxied to the view's own MCP server.
 * @returns {Promise<Object>} CallToolResult
 */
export const callMcpAppTool = async ({ appId, toolId, name, args }) => {
  const { data } = await apiClient.post(
    '/mcp-apps/tools/call',
    { appId, toolId, name, arguments: args || {} },
    // A tool call may run as long as the server's MCP timeout allows.
    { timeout: 10 * 60 * 1000 }
  );
  return data;
};

/**
 * A `resources/read` made by the view, proxied to the view's own MCP server.
 * @returns {Promise<{contents: Array}>}
 */
export const readMcpAppResource = async ({ appId, toolId, uri }) => {
  const { data } = await apiClient.post('/mcp-apps/resources/read', { appId, toolId, uri });
  return data;
};

/**
 * Tell the server how a view completed its handshake, so admins can see in the
 * server log which MCP servers still rely on the legacy mcp-ui `appReady`
 * message instead of `ui/initialize`. Fire-and-forget.
 * @param {{appId: string, toolId: string, handshake: 'legacy'}} params
 * @returns {Promise<void>}
 */
export const reportMcpAppHandshake = async ({ appId, toolId, handshake }) => {
  await apiClient.post('/mcp-apps/handshake', { appId, toolId, handshake });
};

/**
 * URL of the sandbox proxy page, carrying the view's declared CSP domains.
 * The server turns them (sanitized) into the page's CSP header.
 * @param {Object} csp - `{ connectDomains, resourceDomains, frameDomains, baseUriDomains }`
 * @returns {string}
 */
export const buildMcpAppSandboxUrl = csp =>
  `${buildApiUrl('mcp-apps/sandbox')}?csp=${encodeURIComponent(JSON.stringify(csp || {}))}`;
