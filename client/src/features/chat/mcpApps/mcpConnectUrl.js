/**
 * URLs of the per-user MCP sign-in: where to send the browser to connect a
 * server, and where it should come back to.
 *
 * @module features/chat/mcpApps/mcpConnectUrl
 */
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { MCP_CONNECT_PARAMS } from './mcpConnectPrompts';

/**
 * The current page URL without the sign-in result parameters — where the
 * browser should come back to after connecting.
 *
 * @param {string} [href]
 * @returns {string}
 */
export function currentReturnUrl(href = window.location.href) {
  const url = new URL(href);
  for (const name of MCP_CONNECT_PARAMS) url.searchParams.delete(name);
  return url.toString();
}

/**
 * The URL that starts the sign-in for a server. Built from the API base on
 * the client (not from the server-sent path) so base-path and browser
 * extension deployments resolve it the same way as every other API call.
 *
 * @param {string} serverId
 * @param {string} [returnUrl]
 * @returns {string}
 */
export function buildMcpConnectUrl(serverId, returnUrl = currentReturnUrl()) {
  const params = new URLSearchParams({ serverId, returnUrl });
  return `${buildApiUrl('mcp/oauth/authorize')}?${params.toString()}`;
}
