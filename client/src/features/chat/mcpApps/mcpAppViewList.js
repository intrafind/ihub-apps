/**
 * MCP App views on a chat message.
 *
 * A tool that renders an MCP App view announces it on `tool/started`
 * (`mcpApp: { serverId, toolName, resourceUri }`) and ships the data it is
 * drawn from on `tool/completed` (`mcpApp: { callId, toolId, …, args,
 * toolResult }`). The run reducer keeps both on the tool entry; this module
 * projects them onto `message.mcpApps`, the same shape the server stores with
 * the answer so a reopened chat renders them again.
 *
 * @module features/chat/mcpApps/mcpAppViewList
 */

/**
 * @param {Object} run - Run state from the run reducer
 * @returns {Array<Object>|null} View descriptors, or null when there are none
 */
export function buildMcpAppViews(run) {
  const views = [];
  for (const tool of run?.tools || []) {
    const ref = tool?.mcpApp;
    if (!ref || typeof ref.resourceUri !== 'string') continue;
    if (ref.callId) {
      // The finished view from `tool/completed`.
      views.push({ ...ref, status: tool.status === 'error' ? 'error' : 'completed' });
      continue;
    }
    views.push({
      callId: String(tool.callId),
      toolId: String(tool.toolId),
      serverId: ref.serverId,
      toolName: ref.toolName,
      resourceUri: ref.resourceUri,
      args: tool.args && typeof tool.args === 'object' ? tool.args : {},
      status: tool.status === 'running' ? 'running' : 'completed'
    });
  }
  return views.length > 0 ? views : null;
}

/**
 * Stored views (from the chat store or sessionStorage) as the renderer
 * expects them. Unknown or malformed entries are dropped.
 *
 * @param {unknown} views
 * @returns {Array<Object>}
 */
export function normalizeMcpAppViews(views) {
  if (!Array.isArray(views)) return [];
  return views
    .filter(
      v =>
        v &&
        typeof v === 'object' &&
        typeof v.callId === 'string' &&
        typeof v.toolId === 'string' &&
        typeof v.resourceUri === 'string'
    )
    .map(v => ({ ...v, status: v.status || 'completed' }));
}
