/**
 * Groups an app's selected tool ids by their originating MCP server so the
 * end-user tools menu shows one toggle per server (e.g. "Excalidraw") instead
 * of every granular tool id it exposes (excalidraw__read_me, excalidraw__create_view).
 * Plain script-backed tools (no `_mcp` metadata) stay individual. A server
 * contributes no group when none of its tools are selected for the app.
 *
 * @param {string[]} appToolIds - app.tools
 * @param {Array<{id:string,_mcp?:{serverId:string,serverName?:object|string}}>} availableTools
 * @param {(content:any)=>string} localize - resolves a possibly-localized name to a display string
 * @returns {{grouped: Array<{id:string,name:string,matchedTools:string[]}>, individual: string[]}}
 */
export function groupToolsByMcpServer(appToolIds, availableTools, localize) {
  if (!appToolIds || appToolIds.length === 0) return { grouped: [], individual: [] };

  const mcpGroups = new Map();
  const individual = [];

  appToolIds.forEach(toolId => {
    const mcp = availableTools.find(tool => tool.id === toolId)?._mcp;
    if (!mcp?.serverId) {
      individual.push(toolId);
      return;
    }
    if (!mcpGroups.has(mcp.serverId)) {
      mcpGroups.set(mcp.serverId, {
        id: `mcp-${mcp.serverId}`,
        name: localize(mcp.serverName) || mcp.serverId,
        matchedTools: []
      });
    }
    mcpGroups.get(mcp.serverId).matchedTools.push(toolId);
  });

  return { grouped: Array.from(mcpGroups.values()), individual };
}
