// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 *
 * A tool that needs a person's approval (#2945) does not run: the answer is
 * `{ awaitingApproval: true, interaction }`, the host shows the approval card
 * and sends the decision with {@link answerMcpAppToolApproval}. `chatId` and
 * `toolApprovalCapable` say where the card can be shown; without them such a
 * call is refused (`APPROVAL_REQUIRED_NO_USER`).
 *
 * @returns {Promise<Object>} CallToolResult, or `{ awaitingApproval, interaction }`
 */
export const callMcpAppTool = async ({
  appId,
  toolId,
  name,
  args,
  chatId = null,
  toolApprovalCapable = false
}) => {
  const { data } = await apiClient.post(
    '/mcp-apps/tools/call',
    {
      appId,
      toolId,
      name,
      arguments: args || {},
      ...(chatId ? { chatId } : {}),
      ...(toolApprovalCapable ? { toolApprovalCapable: true } : {})
    },
    // A tool call may run as long as the server's MCP timeout allows.
    { timeout: 10 * 60 * 1000 }
  );
  return data;
};

/**
 * The decision on a view's call that waits for approval (#2945). On approve
 * the server runs the stored call: the answer is the view's CallToolResult.
 * Reject and expiry answer with a tool error (`USER_REJECTED`,
 * `APPROVAL_EXPIRED`).
 *
 * @param {{appId: string, toolId: string, interactionId: string, decision: 'approve'|'reject'}} params
 * @returns {Promise<Object>} CallToolResult
 */
export const answerMcpAppToolApproval = async ({ appId, toolId, interactionId, decision }) => {
  const { data } = await apiClient.post(
    '/mcp-apps/tools/call/approval',
    { appId, toolId, interactionId, decision },
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
