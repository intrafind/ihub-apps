/**
 * Groups an app's tool references by their originating MCP server so the
 * end-user tools menu shows one toggle per server (e.g. "draw.io") and never
 * the granular tools it exposes (create_diagram, search_shapes).
 *
 * An app enables an MCP server by listing the server's id in `app.tools`
 * (`"drawio"`); apps configured before that list the server's tool ids
 * instead. Both kinds of reference fold into the server's single group, whose
 * `matchedTools` are the app's references that belong to it — the ids the
 * toggle adds to or removes from `enabledTools`. A tool with no `_mcp`
 * metadata, or a reference no loaded tool resolves, stays individual.
 *
 * @param {string[]} appToolIds - app.tools
 * @param {Array<{id:string,_mcp?:{serverId:string,serverName?:object|string}}>} availableTools
 * @param {(content:any)=>string} localize - resolves a possibly-localized name to a display string
 * @returns {{grouped: Array<{id:string,name:string,matchedTools:string[]}>, individual: string[]}}
 */
export function groupToolsByMcpServer(appToolIds, availableTools, localize) {
  if (!appToolIds || appToolIds.length === 0) return { grouped: [], individual: [] };

  const tools = availableTools || [];
  const mcpGroups = new Map();
  const individual = [];

  appToolIds.forEach(toolId => {
    const tool = tools.find(candidate => candidate.id === toolId);
    const mcp = tool
      ? tool._mcp
      : tools.find(candidate => candidate._mcp?.serverId === toolId)?._mcp;
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
